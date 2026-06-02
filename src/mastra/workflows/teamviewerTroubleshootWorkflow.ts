import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import {
  AgentExecution,
  AgentName,
  ActionItem,
  JobType,
  ProductKey,
  RootCauseCandidate,
  WorkflowReport
} from "../../types.js";
import { inferIssueBuckets, productBaselineBuckets, selectAgents } from "../../agents/routing.js";
import type { Agent } from "@mastra/core/agent";
import {
  authPolicyAgent,
  connectivityAgent,
  endpointHealthAgent,
  gatewayAgent,
  logIntelligenceAgent
} from "../agents/index.js";
import {
  runAuthPolicyAnalysis,
  runConnectivityAnalysis,
  runEndpointHealthAnalysis,
  runLogIntelligenceAnalysis
} from "../tools/specialistTools.js";
import { sanitizePromptInput } from "../util/sanitize.js";
import { groundingFacts, type DocTopic } from "../../knowledge/teamviewerDocs.js";
import { generateStructured } from "../util/llmJson.js";

const inputSchema = z.object({
  product: z.string(),
  task: z.enum(["debug", "troubleshoot"]),
  target: z.string(),
  issue: z.string(),
  context: z.string().optional()
});
type WorkflowInput = z.infer<typeof inputSchema>;

const rootCauseSchema = z.object({
  title: z.string(),
  score: z.number(),
  rationale: z.string()
});

const actionSchema = z.object({
  step: z.string(),
  risk: z.enum(["low", "medium", "high"]),
  rollback: z.string()
});

const reportSchema = z.object({
  summary: z.string(),
  hypotheses: z.array(z.string()),
  evidence: z.array(z.string()),
  rootCauses: z.array(rootCauseSchema),
  actions: z.array(actionSchema),
  confidence: z.number(),
  escalation: z.object({ required: z.boolean(), reason: z.string() }),
  execution: z.array(
    z.object({
      name: z.string(),
      status: z.enum(["completed", "failed", "skipped"]),
      note: z.string()
    })
  )
});

const metaSchema = inputSchema.extend({
  buckets: z.array(z.string()),
  hypotheses: z.array(z.string())
});

const specialistResultSchema = z.object({
  meta: metaSchema,
  key: z.enum(["connectivity", "auth-policy", "endpoint-health", "log-intelligence"]),
  status: z.enum(["completed", "skipped", "failed"]),
  note: z.string(),
  evidence: z.array(z.string()),
  rootCauses: z.array(rootCauseSchema),
  actions: z.array(actionSchema),
  hypotheses: z.array(z.string())
});
type SpecialistResult = z.infer<typeof specialistResultSchema>;

// ---------------------------------------------------------------------------
// Step 1: classify (gateway LLM) — infer buckets + seed hypotheses
// ---------------------------------------------------------------------------

const classifyStep = createStep({
  id: "classify-and-plan",
  inputSchema,
  outputSchema: metaSchema,
  execute: async ({ inputData }: { inputData: WorkflowInput }) => {
    const issue = sanitizePromptInput(inputData.issue);
    const context = sanitizePromptInput(inputData.context, 2000);

    const deterministicBuckets = inferIssueBuckets({
      target: inputData.target,
      issue: inputData.issue,
      context: inputData.context
    });

    // Foundry Local is mandatory. The LLM classification runs with no fallback;
    // a persistent failure throws and fails the job. The deterministic buckets
    // are only a seed that is merged with the model's output, never a substitute.
    const planPrompt =
      "You are a TeamViewer triage planner. Classify the issue into one or more buckets " +
      "from this exact set: connectivity, auth-policy, endpoint-health, log-intelligence, generic. " +
      "Also produce 3-6 short triage hypotheses ordered most-likely-first.\n" +
      `Task: ${inputData.task}\n` +
      `Product: ${inputData.product}\n` +
      `Target: ${sanitizePromptInput(inputData.target, 200)}\n` +
      `Issue: ${issue}\n` +
      `Context: ${context || "none"}\n\n` +
      'Reply ONLY with JSON: {"buckets":["..."],"hypotheses":["..."]}';

    const parsed = await generateStructured(gatewayAgent, planPrompt, {
      schema: z.object({
        buckets: z.array(z.string()).min(1),
        hypotheses: z.array(z.string()).default([])
      }),
      retries: 1
    });

    const allowed = new Set(["connectivity", "auth-policy", "endpoint-health", "log-intelligence", "generic"]);
    const cleaned = parsed.buckets.map((b) => b.toLowerCase().trim()).filter((b) => allowed.has(b));
    const productBuckets = productBaselineBuckets(inputData.product);
    const buckets = Array.from(new Set([...deterministicBuckets, ...productBuckets, ...cleaned]));
    let hypotheses = (parsed.hypotheses ?? []).map((h) => h.trim()).filter(Boolean).slice(0, 6);

    if (hypotheses.length === 0) {
      hypotheses = [`Issue statement baseline: ${inputData.issue}`];
    }

    return { ...inputData, buckets, hypotheses };
  }
});

// ---------------------------------------------------------------------------
// Specialist step factory — wraps each Mastra agent uniformly
// ---------------------------------------------------------------------------

type SpecialistKey = "connectivity" | "auth-policy" | "endpoint-health" | "log-intelligence";

interface SpecialistDef {
  key: SpecialistKey;
  stepId: string;
  // Each specialist has a different generic Agent type; we only need .generate(), so widen.
  agent: Agent<string, any, undefined, unknown>;
  baseline: (input: { product?: string; target: string; issue: string; context?: string }) => Promise<{
    evidence: string[];
    rootCauses: RootCauseCandidate[];
    actions: ActionItem[];
  }>;
  active: (buckets: string[], task: JobType) => boolean;
  topic: string;
}

const specialists: SpecialistDef[] = [
  {
    key: "connectivity",
    stepId: "specialist-connectivity",
    agent: connectivityAgent as unknown as SpecialistDef["agent"],
    baseline: runConnectivityAnalysis,
    active: (b) => b.includes("connectivity"),
    topic: "network reachability, VPN, DNS, firewall and packet-loss"
  },
  {
    key: "auth-policy",
    stepId: "specialist-auth-policy",
    agent: authPolicyAgent as unknown as SpecialistDef["agent"],
    baseline: runAuthPolicyAnalysis,
    active: (b) => b.includes("auth-policy"),
    topic: "authentication, SSO, token freshness and policy propagation"
  },
  {
    key: "endpoint-health",
    stepId: "specialist-endpoint-health",
    agent: endpointHealthAgent as unknown as SpecialistDef["agent"],
    baseline: runEndpointHealthAnalysis,
    active: (b) => b.includes("endpoint-health"),
    topic: "endpoint service state, version compatibility and host resources"
  },
  {
    key: "log-intelligence",
    stepId: "specialist-log-intelligence",
    agent: logIntelligenceAgent as unknown as SpecialistDef["agent"],
    baseline: runLogIntelligenceAnalysis,
    active: (b, t) => b.includes("log-intelligence") || b.includes("generic") || t === "debug",
    topic: "recurring log signatures and failure clusters"
  }
];

const enrichmentSchema = z.object({
  hypotheses: z.array(z.string()).default([]),
  rootCauses: z.array(rootCauseSchema).default([]),
  actions: z.array(actionSchema).default([])
});

function buildSpecialistStep(def: SpecialistDef) {
  return createStep({
    id: def.stepId,
    inputSchema: metaSchema,
    outputSchema: specialistResultSchema,
    execute: async ({ inputData }: { inputData: z.infer<typeof metaSchema> }): Promise<SpecialistResult> => {
      const active = def.active(inputData.buckets, inputData.task as JobType);
      if (!active) {
        return {
          meta: inputData,
          key: def.key,
          status: "skipped",
          note: `Bucket ${def.key} not triggered`,
          evidence: [],
          rootCauses: [],
          actions: [],
          hypotheses: []
        };
      }

      const baseline = await def.baseline({
        product: inputData.product,
        target: inputData.target,
        issue: inputData.issue,
        context: inputData.context
      }).catch((err: unknown) => ({
        evidence: [`Baseline probe error: ${err instanceof Error ? err.message : String(err)}`],
        rootCauses: [] as RootCauseCandidate[],
        actions: [] as ActionItem[]
      }));

      const issue = sanitizePromptInput(inputData.issue);
      const context = sanitizePromptInput(inputData.context, 2000);

      const docTopic: DocTopic =
        def.key === "log-intelligence" ? "logs" : (def.key as DocTopic);
      const facts = groundingFacts([docTopic], inputData.product);
      const referenceLine =
        facts.length > 0 ? `Official references (verified): ${facts.join(" | ")}\n` : "";

      const prompt =
        `You are the TeamViewer ${def.key} specialist. Focus exclusively on ${def.topic}.\n` +
        `Issue: ${issue}\n` +
        `Context: ${context || "none"}\n` +
        referenceLine +
        `Baseline evidence: ${baseline.evidence.join(" | ")}\n` +
        `Baseline root cause: ${baseline.rootCauses.map((r) => r.title).join(" | ")}\n\n` +
        "Add up to 3 prioritized hypotheses, up to 2 additional root causes (score 0.0-1.0), " +
        "and up to 3 actions (risk: low|medium|high, with rollback). Stay strictly within your specialty.\n" +
        'Reply ONLY with JSON: {"hypotheses":["..."],"rootCauses":[{"title":"...","score":0.7,"rationale":"..."}],"actions":[{"step":"...","risk":"low","rollback":"..."}]}';

      type Enrichment = z.infer<typeof enrichmentSchema>;

      // Foundry Local is mandatory: no fallback. A persistent LLM failure throws
      // and fails the whole job rather than degrading to baseline-only output.
      const result = await generateStructured(def.agent, prompt, {
        schema: enrichmentSchema,
        retries: 1
      });
      const enrichment: Enrichment = {
        hypotheses: result.hypotheses ?? [],
        rootCauses: result.rootCauses ?? [],
        actions: result.actions ?? []
      };
      const status: SpecialistResult["status"] = "completed";
      const note = `Mastra agent ${def.key} executed via Foundry Local`;

      const enrichmentRoots = enrichment.rootCauses ?? [];
      const enrichmentActions = enrichment.actions ?? [];
      const enrichmentHypotheses = enrichment.hypotheses ?? [];
      const mergedRoots = [...baseline.rootCauses, ...enrichmentRoots]
        .map((r) => ({
          title: r.title.trim(),
          score: Math.max(0, Math.min(1, Number(r.score) || 0)),
          rationale: r.rationale.trim()
        }))
        .filter((r) => r.title);

      const allowedRisk = new Set(["low", "medium", "high"] as const);
      const mergedActions = [...baseline.actions, ...enrichmentActions]
        .map((a) => ({
          step: a.step.trim(),
          risk: (allowedRisk.has(a.risk as "low" | "medium" | "high") ? a.risk : "low") as "low" | "medium" | "high",
          rollback: a.rollback.trim()
        }))
        .filter((a) => a.step);

      return {
        meta: inputData,
        key: def.key,
        status,
        note,
        evidence: baseline.evidence,
        rootCauses: mergedRoots,
        actions: mergedActions,
        hypotheses: enrichmentHypotheses.map((h) => h.trim()).filter(Boolean).slice(0, 3)
      };
    }
  });
}

const connectivityStep = buildSpecialistStep(specialists[0]);
const authPolicyStep = buildSpecialistStep(specialists[1]);
const endpointHealthStep = buildSpecialistStep(specialists[2]);
const logIntelligenceStep = buildSpecialistStep(specialists[3]);

// ---------------------------------------------------------------------------
// Aggregate step — gateway LLM rerank + summary
// ---------------------------------------------------------------------------

const parallelOutputSchema = z.object({
  [connectivityStep.id]: specialistResultSchema,
  [authPolicyStep.id]: specialistResultSchema,
  [endpointHealthStep.id]: specialistResultSchema,
  [logIntelligenceStep.id]: specialistResultSchema
});

const aggregateStep = createStep({
  id: "aggregate-report",
  inputSchema: parallelOutputSchema,
  outputSchema: reportSchema,
  execute: async ({ inputData }: { inputData: z.infer<typeof parallelOutputSchema> }): Promise<WorkflowReport> => {
    const branches: SpecialistResult[] = [
      inputData[connectivityStep.id],
      inputData[authPolicyStep.id],
      inputData[endpointHealthStep.id],
      inputData[logIntelligenceStep.id]
    ];
    const meta = branches[0].meta;

    const evidence = [
      `Target scope: ${meta.target}`,
      meta.context ? `Context captured: ${meta.context}` : "Context captured: no extra context provided",
      ...branches.flatMap((b) => b.evidence)
    ];
    const allHypotheses = Array.from(
      new Set([...meta.hypotheses, ...branches.flatMap((b) => b.hypotheses)])
    ).slice(0, 8);
    const allRoots = branches.flatMap((b) => b.rootCauses);
    const allActions = deduplicateActions(branches.flatMap((b) => b.actions));

    // LLM rerank of root causes (narrow JSON contract)
    let rerankedRoots: RootCauseCandidate[] = allRoots;
    if (allRoots.length > 1) {
      const rerankPrompt =
        "Rerank the candidate root causes for this TeamViewer issue. Keep titles and rationales unchanged, " +
        "only adjust scores (0.0-1.0) to reflect likelihood given the issue text. Return all candidates.\n" +
        `Issue: ${sanitizePromptInput(meta.issue)}\n` +
        `Context: ${sanitizePromptInput(meta.context, 1500) || "none"}\n` +
        `Candidates: ${JSON.stringify(allRoots)}\n\n` +
        'Reply ONLY with JSON: {"rootCauses":[{"title":"...","score":0.0,"rationale":"..."}]}';
      const reranked = await generateStructured(gatewayAgent, rerankPrompt, {
        schema: z.object({ rootCauses: z.array(rootCauseSchema) }),
        retries: 1
      });
      const knownTitles = new Map(allRoots.map((r) => [r.title, r]));
      rerankedRoots = reranked.rootCauses
        .filter((r) => knownTitles.has(r.title))
        .map((r) => ({ ...knownTitles.get(r.title)!, score: Math.max(0, Math.min(1, Number(r.score) || 0)) }));
      if (rerankedRoots.length === 0) {
        rerankedRoots = allRoots;
      }
    }

    const topRoots = rerankedRoots.sort((a, b) => b.score - a.score).slice(0, 3);
    const confidence = calculateConfidence(topRoots, evidence.length, meta.task as JobType);
    const escalationRequired = confidence < 0.6 || (topRoots[0]?.score ?? 0) < 0.65;

    // LLM-generated executive summary (plain text, single line). Mandatory —
    // Foundry Local must produce it; an empty/failed generation throws.
    const summaryPrompt =
      "Write ONE short sentence (max 35 words) summarizing the troubleshooting outcome. No prose around it, no JSON, no markdown.\n" +
      `Task: ${meta.task}\n` +
      `Product: ${meta.product}\n` +
      `Top root cause: ${topRoots[0]?.title ?? "unclassified"}\n` +
      `Confidence: ${confidence.toFixed(2)}\n` +
      `Issue: ${sanitizePromptInput(meta.issue, 400)}`;
    const summaryOut = await gatewayAgent.generate(summaryPrompt);
    const summary = (summaryOut.text ?? "").trim().split(/\r?\n/)[0].trim();
    if (!summary) {
      throw new Error("Foundry Local returned an empty summary; aborting (no fallback).");
    }

    const selected = selectAgents(meta.task as JobType, meta.buckets);
    const branchStatus = new Map(branches.map((b) => [b.key, b]));
    const execution: AgentExecution[] = selected.map((name) => {
      const branch = branchStatus.get(name as SpecialistKey);
      if (branch) {
        return { name: name as AgentName, status: branch.status, note: branch.note };
      }
      return { name: name as AgentName, status: "completed", note: `Mastra orchestrator step ${name} completed` };
    });

    return {
      summary,
      hypotheses: allHypotheses,
      evidence,
      rootCauses: topRoots,
      actions: allActions,
      confidence,
      escalation: {
        required: escalationRequired,
        reason: escalationRequired
          ? "Low confidence or ambiguous root cause, escalate to L3 TeamViewer specialist"
          : "Root cause confidence acceptable, proceed with guided remediation"
      },
      execution
    };
  }
});

export const teamviewerTroubleshootWorkflow = createWorkflow({
  id: "teamviewer-troubleshoot-workflow",
  inputSchema,
  outputSchema: reportSchema
})
  .then(classifyStep)
  .parallel([connectivityStep, authPolicyStep, endpointHealthStep, logIntelligenceStep])
  .then(aggregateStep)
  .commit();

// ---------------------------------------------------------------------------
// Helpers (exported for unit tests)
// ---------------------------------------------------------------------------

export function calculateConfidence(rootCauses: RootCauseCandidate[], evidenceCount: number, task: JobType): number {
  const top = rootCauses[0]?.score ?? 0.5;
  const evidenceBoost = Math.min(0.15, evidenceCount * 0.02);
  const taskBoost = task === "troubleshoot" ? 0.05 : 0;
  return Math.min(0.95, top + evidenceBoost + taskBoost);
}

export function deduplicateActions(actions: ActionItem[]): ActionItem[] {
  const unique = new Map<string, ActionItem>();
  for (const action of actions) {
    unique.set(action.step, action);
  }
  return Array.from(unique.values());
}

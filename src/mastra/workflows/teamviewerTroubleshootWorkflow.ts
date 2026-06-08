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
  risk: z
    .string()
    .transform((s) => s.trim().toLowerCase())
    .pipe(z.enum(["low", "medium", "high"])),
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

    // Drop actions whose recommendation is already disproven by the evidence
    // (e.g. "check firewall for port 5938" when the connectivity probe just
    // proved 5938 is reachable). Prevents the synthesized report from
    // contradicting its own evidence section.
    const filteredActions = filterActionsAgainstEvidence(allActions, evidence);

    // LLM-generated executive summary (plain text, single line). Mandatory —
    // Foundry Local must produce it; if the small local model emits garbage
    // (tool-call JSON, code fences, the literal NOT_IN_CONTEXT marker) we
    // retry once with a stricter prompt and finally fall back to a
    // deterministic one-liner built from the top root cause + confidence.
    const buildSummaryPrompt = (strict: boolean) =>
      (strict
        ? "Output EXACTLY one short English sentence (max 35 words). Do NOT call any tool. Do NOT emit JSON, code fences, markdown, or function-call syntax. Plain prose only.\n"
        : "Write ONE short sentence (max 35 words) summarizing the troubleshooting outcome. No prose around it, no JSON, no markdown.\n") +
      `Task: ${meta.task}\n` +
      `Product: ${meta.product}\n` +
      `Top root cause: ${topRoots[0]?.title ?? "unclassified"}\n` +
      `Confidence: ${confidence.toFixed(2)}\n` +
      `Issue: ${sanitizePromptInput(meta.issue, 400)}`;

    let summary = "";
    for (const strict of [false, true]) {
      const out = await gatewayAgent.generate(buildSummaryPrompt(strict));
      summary = cleanSummary(out.text ?? "");
      if (summary) break;
    }
    if (!summary) {
      // Deterministic last-resort summary — keeps the report renderable when
      // the local model wedges or insists on tool-calling. NOT a confidence
      // boost: escalation/confidence numbers are unchanged.
      const topTitle = topRoots[0]?.title ?? "unclassified";
      summary = `${meta.task === "debug" ? "Debug" : "Troubleshoot"} run completed for ${meta.product}; top candidate root cause: ${topTitle} (confidence ${confidence.toFixed(2)}).`;
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
      actions: filteredActions,
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

/**
 * Strips garbage shapes that the small local model sometimes emits in place
 * of a plain-text summary: tool-call JSON, code fences, the NOT_IN_CONTEXT
 * marker (used by docsComposerAgent), or a stray empty JSON object. Returns
 * the first non-empty line, or "" if nothing usable remains.
 */
export function cleanSummary(raw: string): string {
  let s = (raw ?? "").trim();
  if (!s) return "";
  // Strip markdown code fences (``` or ```json) and surrounding whitespace.
  s = s.replace(/^```[a-zA-Z]*\n?/, "").replace(/\n?```$/, "").trim();
  // Keep only the first non-empty line.
  s = s.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  if (!s) return "";
  // Reject obvious garbage shapes.
  if (/^NOT_IN_CONTEXT$/i.test(s)) return "";
  // Tool-call JSON: {"name":"someTool", "arguments": {...}} — the gateway
  // agent has tools bound, and small models sometimes serialize a tool call
  // as text instead of executing it.
  if (/^\s*\{/.test(s) && /"(name|tool|function|arguments|parameters)"\s*:/i.test(s)) return "";
  // Mentions of internal tool ids — also leaked tool-call text.
  if (/teamviewerDocsTool|connectivityTool|authPolicyTool|endpointHealthTool|logIntelligenceTool/i.test(s)) return "";
  return s;
}

/**
 * Drops actions whose recommendation is directly contradicted by probe
 * evidence we already collected. Currently focused on the most common case:
 * "check firewall for port 5938 / TeamViewer traffic" when the connectivity
 * probe just proved 5938 is reachable. Conservative — only drops when an
 * action mentions BOTH a firewall keyword AND the proven-open port.
 */
export function filterActionsAgainstEvidence(
  actions: ActionItem[],
  evidence: string[]
): ActionItem[] {
  const joined = evidence.join(" ");
  const lower = joined.toLowerCase();
  // "TCP 5938 reachability: 3/3 routers OK" — routers reachable on 5938.
  // The probe formats it as "<n>/<m> routers OK" so allow intermediate words
  // between the ratio and the OK marker.
  const port5938Open = /tcp\s+5938\s+reachability:\s*\d+\/\d+[^\n]*?\bok\b/i.test(joined);
  // "HTTPS webapi probe: HTTP 200" — outbound HTTPS works.
  const httpsOk = /https\s+webapi\s+probe:\s*http\s*2\d{2}/i.test(joined);
  // Overall connectivity verdict from runConnectivityAnalysis.
  const allConnOk = /all baseline connectivity probes succeeded/i.test(lower);

  return actions.filter((a) => {
    const text = `${a.step} ${a.rollback ?? ""} ${a.command ?? ""}`.toLowerCase();
    const mentionsFirewall = /firewall/.test(text);
    if (!mentionsFirewall) return true;
    // Action explicitly about port 5938 and we just proved it open → drop.
    if (port5938Open && /\b5938\b/.test(text)) return false;
    // Generic "firewall blocking TeamViewer traffic" with no port specified,
    // and all baseline connectivity probes succeeded → drop.
    if (allConnOk && /teamviewer/.test(text) && !/\b\d{2,5}\b/.test(text)) return false;
    // Generic firewall action while HTTPS works AND 5938 works → still drop.
    if (httpsOk && port5938Open && /(teamviewer traffic|blocking teamviewer)/.test(text)) return false;
    return true;
  });
}

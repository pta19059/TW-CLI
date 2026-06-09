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
import { groundingFacts, retrieveKnowledgeHits, isReferenceCandidate, isKbArticleUrl, referenceRelevance, REFERENCE_STRONG_FLOOR, type DocTopic, type KnowledgeHit } from "../../knowledge/teamviewerDocs.js";
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
  rationale: z.string(),
  /** Probe-derived (true) vs LLM-generated (false/undefined). See RootCauseCandidate. */
  evidenceAnchored: z.boolean().optional()
});

const actionSchema = z.object({
  step: z.string(),
  risk: z
    .string()
    .transform((s) => s.trim().toLowerCase())
    .pipe(z.enum(["low", "medium", "high"])),
  rollback: z.string()
});

const referenceSchema = z.object({
  title: z.string().optional(),
  source: z.string(),
  topic: z.string(),
  /** Blended on-topic score (teamviewerDocs.referenceRelevance) used to sort
   *  and cap references globally so only the most relevant pages are cited. */
  relevance: z.number().optional()
});

const logSourceSchema = z.object({
  source: z.string(),
  detail: z.string().optional()
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
  ),
  references: z.array(referenceSchema).default([]),
  logSources: z.array(logSourceSchema).default([])
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
  hypotheses: z.array(z.string()),
  references: z.array(referenceSchema).default([]),
  logSources: z.array(logSourceSchema).default([])
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
    logSources?: Array<{ source: string; detail?: string }>;
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
          hypotheses: [],
          references: [],
          logSources: []
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
        actions: [] as ActionItem[],
        logSources: [] as Array<{ source: string; detail?: string }>
      }));

      const issue = sanitizePromptInput(inputData.issue);
      const context = sanitizePromptInput(inputData.context, 2000);

      const docTopic: DocTopic =
        def.key === "log-intelligence" ? "logs" : (def.key as DocTopic);
      const facts = groundingFacts([docTopic], inputData.product);
      const referenceLine =
        facts.length > 0 ? `Official references (verified): ${facts.join(" | ")}\n` : "";

      // KB-grounded anchor passages from the LanceDB hybrid retriever.
      // Build a focused query from the issue + specialty topic so each
      // specialist gets passages tuned to its slice (connectivity / auth /
      // endpoint / logs), then inject the top-3 as ANCHOR snippets in the
      // prompt. Failure here is non-fatal — retrieval may be offline or empty
      // (no index yet) and the specialist still has groundingFacts + baseline.
      let kbAnchors = "";
      const kbReferences: Array<{ title?: string; source: string; topic: string; relevance?: number }> = [];
      try {
        const kbQuery = `${def.topic} ${issue}`.slice(0, 240);
        const { hits } = await retrieveKnowledgeHits(kbQuery);
        // Score/gate references against the USER ISSUE alone, NOT the broad
        // `${topic} ${issue}` retrieval query. The topic string ("network
        // reachability, VPN, DNS, firewall and packet-loss") inflates keyword
        // coverage for any vaguely-networking page, so gating on it let
        // off-topic pages ("Use TeamViewer on cloned systems", the product
        // landing page) slip into the citations. The issue text ("drops every
        // few minutes") is the precise relevance signal.
        const relevanceQuery = issue.slice(0, 240);
        // Prompt ANCHORS: top-3 only, to keep the prompt tight.
        const top = hits.slice(0, 3).map((h: KnowledgeHit) => {
          const snippet = h.text.replace(/\s+/g, " ").trim().slice(0, 220);
          const label = h.title ? `${h.title}` : h.source;
          return `- [${label}] ${snippet}`;
        });
        // REFERENCES: evaluate the FULL returned pool (not just the top-3) and
        // keep every candidate that clears the relaxed "related" floor, tagging
        // each with its relevance. The aggregate step does the final tiering
        // (strong always shown; related KB-articles backfill a sparse list) and
        // capping — centralizing the decision across all four specialists so a
        // genuinely relevant article surfaced by one specialist isn't dropped
        // just because it wasn't that specialist's top-3.
        for (const h of hits) {
          if (h.source && isReferenceCandidate(relevanceQuery, h)) {
            kbReferences.push({
              title: h.title,
              source: h.source,
              topic: def.topic,
              relevance: referenceRelevance(relevanceQuery, h)
            });
          }
        }
        if (top.length > 0) {
          kbAnchors = `KB anchors (use these to ground hypotheses/actions; cite the bracketed label inline if you reuse a passage):\n${top.join("\n")}\n`;
        }
      } catch { /* retrieval optional */ }

      const prompt =
        `You are the TeamViewer ${def.key} specialist. Focus exclusively on ${def.topic}.\n` +
        `Issue: ${issue}\n` +
        `Context: ${context || "none"}\n` +
        referenceLine +
        kbAnchors +
        `Baseline evidence: ${baseline.evidence.join(" | ")}\n` +
        `Baseline root cause: ${baseline.rootCauses.map((r) => r.title).join(" | ")}\n\n` +
        "Add up to 3 prioritized hypotheses, up to 2 additional root causes (score 0.0-1.0), " +
        "and up to 3 actions (risk: low|medium|high, with rollback). Stay strictly within your specialty. " +
        "Prefer hypotheses/actions that are SUPPORTED by the KB anchors above. " +
        "Do NOT contradict the baseline evidence (e.g. do not suggest opening a port that the baseline already proved reachable).\n" +
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
      // Tag provenance: baseline root causes come straight from a probe (a real
      // log signature, a failed connectivity check) and are ALWAYS trusted;
      // enrichment root causes are LLM guesses that must earn their place by
      // anchoring to the collected evidence (see filterRootCausesAgainstEvidence).
      const mergedRoots = [
        ...baseline.rootCauses.map((r) => ({ ...r, evidenceAnchored: true })),
        ...enrichmentRoots.map((r) => ({ ...r, evidenceAnchored: false }))
      ]
        .map((r) => ({
          title: r.title.trim(),
          score: Math.max(0, Math.min(1, Number(r.score) || 0)),
          rationale: r.rationale.trim(),
          evidenceAnchored: r.evidenceAnchored
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
        hypotheses: enrichmentHypotheses.map((h) => h.trim()).filter(Boolean).slice(0, 3),
        references: kbReferences,
        logSources: baseline.logSources ?? []
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
    // Drop root-cause candidates that are directly contradicted by the
    // collected evidence (same logic as for actions) BEFORE the LLM rerank
    // — otherwise the LLM keeps re-promoting them.
    const filteredRoots = filterRootCausesAgainstEvidence(allRoots, evidence);
    const allActions = deduplicateActions(branches.flatMap((b) => b.actions));
    // Filter hypotheses the SAME way (they share the same evidence). The
    // hypotheses block in the report had been showing "firewall might block"
    // even when DNS+TCP probes proved the firewall is fine.
    const filteredHypotheses = filterHypothesesAgainstEvidence(allHypotheses, evidence);
    // Aggregate KB references across specialists, deduped by source URL and
    // sorted by on-topic relevance. Two-tier selection so the citation list is
    // neither padded with off-topic filler nor too sparse to be useful:
    //   • STRONG tier (relevance >= REFERENCE_STRONG_FLOOR): always cited.
    //   • RELATED tier (below strong but a real /knowledge-base/ ARTICLE above
    //     the related floor): used ONLY to backfill toward MIN_REFERENCES.
    //     Marketing/product-landing pages (which score in the same band) are
    //     excluded via isKbArticleUrl, so they never sneak back in.
    const MIN_REFERENCES = 4;
    const MAX_REFERENCES = 6;
    const dedupRefMap = new Map<string, { title?: string; source: string; topic: string; relevance?: number }>();
    for (const b of branches) {
      for (const ref of (b.references ?? [])) {
        const existing = dedupRefMap.get(ref.source);
        if (!existing || (ref.relevance ?? 0) > (existing.relevance ?? 0)) {
          dedupRefMap.set(ref.source, ref);
        }
      }
    }
    const sortedRefs = Array.from(dedupRefMap.values()).sort(
      (a, b) => (b.relevance ?? 0) - (a.relevance ?? 0)
    );
    const strongRefs = sortedRefs.filter((r) => (r.relevance ?? 0) >= REFERENCE_STRONG_FLOOR);
    const relatedRefs = sortedRefs.filter(
      (r) => (r.relevance ?? 0) < REFERENCE_STRONG_FLOOR && isKbArticleUrl(r.source)
    );
    const references = [...strongRefs];
    for (const r of relatedRefs) {
      if (references.length >= MIN_REFERENCES) break;
      references.push(r);
    }
    references.splice(MAX_REFERENCES);

    // Collect the concrete log sources consulted across all specialists
    // (only the log specialist populates these). Deduped by source string so
    // the report can show exactly which logs were read on the target.
    const logSourceMap = new Map<string, { source: string; detail?: string }>();
    for (const b of branches) {
      for (const ls of (b.logSources ?? [])) {
        if (!logSourceMap.has(ls.source)) logSourceMap.set(ls.source, ls);
      }
    }
    const logSources = Array.from(logSourceMap.values());

    // LLM rerank of root causes (narrow JSON contract)
    let rerankedRoots: RootCauseCandidate[] = filteredRoots;
    if (filteredRoots.length > 1) {
      const rerankPrompt =
        "Rerank the candidate root causes for this TeamViewer issue. Keep titles and rationales unchanged, " +
        "only adjust scores (0.0-1.0) to reflect likelihood given the issue text. Return all candidates.\n" +
        `Issue: ${sanitizePromptInput(meta.issue)}\n` +
        `Context: ${sanitizePromptInput(meta.context, 1500) || "none"}\n` +
        `Candidates: ${JSON.stringify(filteredRoots)}\n\n` +
        'Reply ONLY with JSON: {"rootCauses":[{"title":"...","score":0.0,"rationale":"..."}]}';
      const reranked = await generateStructured(gatewayAgent, rerankPrompt, {
        schema: z.object({ rootCauses: z.array(rootCauseSchema) }),
        retries: 1
      });
      rerankedRoots = applyRerankScores(filteredRoots, reranked.rootCauses);
      if (rerankedRoots.length === 0) {
        rerankedRoots = filteredRoots;
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

    // LLM-generated executive summary (plain text, single line). The small
    // local model is prone to two failure modes: (a) serializing a tool-call
    // as the answer; (b) echoing the prompt's input labels (e.g. literally
    // outputting "Task: troubleshoot" because the prompt fed it labeled
    // lines). We use a prompt that puts inputs in INLINE PROSE (no
    // line-start labels to echo) and ends with "Sentence:" so the model
    // continues with prose. cleanSummary further rejects label-echo and
    // tool-call shapes. If everything fails, fall back to a deterministic
    // one-liner so the report stays renderable.
    const issueShort = sanitizePromptInput(meta.issue, 240);
    const topTitle = topRoots[0]?.title ?? "unclassified";
    const hasPlausibleCause = topRoots.length > 0 && (topRoots[0]?.score ?? 0) >= 0.5;
    // Do NOT include the confidence number in the prompt — small models
    // misformat it ("high confidence at 0.20%") because they map 0.20
    // to language-level confidence without understanding the scale. The
    // numeric confidence is shown separately in the rendered report.
    const buildSummaryPrompt = (strict: boolean) =>
      (strict
        ? "Output EXACTLY one short English sentence (max 30 words). Plain prose only. No JSON, no tool calls, no markdown, no labels, no percentages, no numbers, no quotes.\n\n"
        : "Write ONE short English sentence (max 30 words) describing the troubleshooting outcome. Plain prose only. No JSON, no tool calls, no markdown, no labels, no percentages, no numbers.\n\n") +
      (hasPlausibleCause
        ? `Brief: A ${meta.task} run for ${meta.product} examined the user issue "${issueShort}" ` +
          `and identified the most likely cause as ${topTitle}.\n\n`
        : `Brief: A ${meta.task} run for ${meta.product} examined the user issue "${issueShort}" ` +
          `and found that all baseline network and service checks succeeded, so no definitive cause was identified; deeper logs or a live reproduction are needed.\n\n`) +
      "Sentence:";

    let summary = "";
    // When we have NO plausible root cause, the LLM tends to hallucinate one
    // (it grabs the only candidate from evidence and invents causality). Use
    // a deterministic neutral summary instead — never let the model invent.
    if (!hasPlausibleCause) {
      summary =
        `${meta.task === "debug" ? "Debug" : "Troubleshoot"} run completed for ${meta.product}: ` +
        "baseline network and service checks all succeeded, so probes did not identify a definitive root cause; " +
        "capture TeamViewer client logs during a live drop and re-run to narrow further.";
    } else {
      for (const strict of [false, true]) {
        const out = await gatewayAgent.generate(buildSummaryPrompt(strict));
        summary = cleanSummary(out.text ?? "");
        if (summary) break;
      }
      if (!summary) {
        summary = `${meta.task === "debug" ? "Debug" : "Troubleshoot"} run completed for ${meta.product}; top candidate root cause: ${topTitle} (confidence ${confidence.toFixed(2)}).`;
      }
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
      hypotheses: filteredHypotheses,
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
      execution,
      references,
      logSources
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
  // Honest floor: when no root cause survives filtering, the previous
  // formula gave 0.5 + 0.15 + 0.05 = 0.70 which looked confidently empty.
  // Cap at 0.55 in that state so the escalation gate (< 0.6) fires.
  if (rootCauses.length === 0) {
    const evidenceBoost = Math.min(0.10, evidenceCount * 0.01);
    return Math.min(0.55, 0.45 + evidenceBoost);
  }
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
 * Merge the LLM rerank output back onto the probe-derived candidates.
 *
 * EVIDENCE-ANCHORED PROTECTION: a candidate tagged `evidenceAnchored === true`
 * came straight from a probe (a counted log signature, a correlated NetWatchdog
 * standby disconnect, a failed connectivity check) and its score was computed
 * from real evidence counts. A small local model (qwen2.5-1.5b) must NOT be
 * able to demote that finding — left to its own devices the rerank knocked the
 * macOS-standby root cause from 0.82 down to the 0.6× floor (0.49), burying the
 * true cause under phantom enrichment guesses and tripping escalation. So
 * evidence-anchored causes KEEP their original score verbatim; the LLM rerank
 * only re-scores enrichment (evidenceAnchored !== true) candidates, which are
 * still floored at 0.6× their original so a model that returns 0 can't silently
 * delete them.
 */
export function applyRerankScores(
  candidates: RootCauseCandidate[],
  reranked: { title: string; score: number }[]
): RootCauseCandidate[] {
  const byTitle = new Map(
    reranked.map((r) => [r.title, Math.max(0, Math.min(1, Number(r.score) || 0))])
  );
  return candidates.map((original) => {
    if (original.evidenceAnchored === true) {
      // Probe-derived truth: preserve the computed score exactly.
      return { ...original };
    }
    const rerankScore = byTitle.get(original.title);
    const floor = original.score * 0.6;
    const finalScore = rerankScore === undefined ? floor : Math.max(floor, rerankScore);
    return { ...original, score: finalScore };
  });
}

/**
 * Strips garbage shapes that the small local model sometimes emits in place
 * of a plain-text summary: tool-call JSON, code fences, the NOT_IN_CONTEXT
 * marker (used by docsComposerAgent), a stray empty JSON object, or an echo
 * of the prompt's input labels ("Task: troubleshoot", "Issue: ...", etc).
 * Returns the first usable line, or "" if nothing remains.
 */
export function cleanSummary(raw: string): string {
  let s = (raw ?? "").trim();
  if (!s) return "";
  // Strip markdown code fences (``` or ```json) and surrounding whitespace.
  s = s.replace(/^```[a-zA-Z]*\n?/, "").replace(/\n?```$/, "").trim();
  // Walk lines and pick the FIRST one that isn't a prompt-label echo or junk.
  const PROMPT_LABEL_RE = /^(task|product|top root cause|confidence|issue|brief|sentence|summary|context|target|note|input|output|answer)\s*[:\-]/i;
  // Meta-talk: the small model often paraphrases its own job instead of
  // answering it ("A brief summary of the troubleshooting outcome is that
  // the system logs were checked"). Reject these so the deterministic
  // fallback fires.
  const META_TALK_RE = /^(a\s+(brief|short|quick|concise)\s+(summary|description|overview|recap|outline)|the\s+(brief|short)?\s*(summary|description|overview)\s+(is|of)|here(?:'s| is)\s+(a\s+)?(brief\s+)?(summary|description|overview)|summary\s+of\s+(the\s+)?troubleshooting|the\s+(troubleshooting|debug)\s+(outcome|run)\s+is|in\s+summary)/i;
  for (const rawLine of s.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^[\-*•\s]+/, "").trim();
    if (!line) continue;
    if (PROMPT_LABEL_RE.test(line)) continue;
    if (META_TALK_RE.test(line)) continue;
    if (/^NOT_IN_CONTEXT$/i.test(line)) continue;
    if (/^\s*\{/.test(line) && /"(name|tool|function|arguments|parameters)"\s*:/i.test(line)) continue;
    if (/teamviewerDocsTool|connectivityTool|authPolicyTool|endpointHealthTool|logIntelligenceTool/i.test(line)) continue;
    return line;
  }
  return "";
}

/**
 * Generic / domain-filler words that carry no diagnostic specificity. A root
 * cause whose ONLY tokens are in this set (or stopwords) is a vague guess with
 * nothing to anchor to the evidence.
 */
const ANCHOR_STOPWORDS = new Set([
  // structural english
  "the", "and", "for", "with", "this", "that", "from", "have", "has", "are",
  "was", "were", "will", "would", "could", "should", "may", "might", "can",
  "due", "via", "into", "onto", "your", "their", "its", "not", "but", "any",
  "all", "out", "off", "per", "had", "been", "being", "such", "than", "then",
  // generic diagnostic filler
  "issue", "issues", "problem", "problems", "error", "errors", "failure",
  "failures", "fail", "fails", "failed", "cause", "causes", "caused", "root",
  "recurring", "recurrence", "suggest", "suggests", "suggested", "possible",
  "possibly", "likely", "potential", "potentially", "related", "relate",
  "relating", "unknown", "general", "generic", "various", "several",
  // domain words present in (almost) every line → not distinctive
  "teamviewer", "remote", "client", "clients", "server", "servers", "system",
  "systems", "host", "hosts", "user", "users", "device", "devices",
  "application", "app", "software", "program", "running", "occur", "occurs",
  "occurring", "happening", "behavior", "behaviour",
  // "service"/"services" appear in nearly every TeamViewer evidence line
  // (process name "TeamViewer_Service", daemon descriptions, etc.) so they
  // are NOT a distinctive anchor — an LLM cause that only touches the evidence
  // via the word "service" ("the TeamViewer service requires admin rights")
  // is still an unanchored guess and must be dropped.
  "service", "services", "daemon", "daemons", "process", "processes"
]);

/**
 * Returns the set of distinctive 4-char stems from a piece of text. Lowercases,
 * keeps alpha runs >= 4 chars, drops stopwords/filler, and reduces each to its
 * 4-char prefix so light inflection (retry/retries/retrying, resolve/resolved/
 * resolver) collapses to the same stem.
 */
export function distinctiveStems(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of (text ?? "").toLowerCase().matchAll(/[a-z]{4,}/g)) {
    const w = m[0];
    if (ANCHOR_STOPWORDS.has(w)) continue;
    out.add(w.slice(0, 4));
  }
  return out;
}

/**
 * A root cause is "evidence-anchored" when at least one of its distinctive
 * stems also appears among the distinctive stems of the collected evidence.
 * This is the discriminator that separates a real, observation-backed cause
 * from a free-floating LLM guess ("Permissions Issue — recurrence suggests
 * permission-related problems" shares NO stem with any probe/log line, so it
 * is rejected). A candidate with no distinctive stems at all (purely generic
 * wording) is treated as unanchored.
 */
export function hasEvidenceAnchor(
  root: { title: string; rationale?: string },
  evidenceStems: Set<string>
): boolean {
  const stems = distinctiveStems(`${root.title} ${root.rationale ?? ""}`);
  if (stems.size === 0) return false;
  for (const s of stems) {
    if (evidenceStems.has(s)) return true;
  }
  return false;
}

/**
 * Same evidence-vs-recommendation logic as filterActionsAgainstEvidence,
 * but applied to root-cause candidates BEFORE the LLM rerank step — the
 * LLM otherwise keeps re-promoting firewall as the top cause even when
 * DNS + TCP both prove the firewall is fine.
 *
 * Drops also catch root causes the LLM RE-INVENTS from our own evidence
 * caveats (e.g. it reads "NOT a candidate root cause for the user's symptom"
 * and helpfully synthesises "Outdated CA bundle" anyway), and bogus
 * "service not registered/running" claims contradicted by the process list.
 */
export function filterRootCausesAgainstEvidence(
  roots: RootCauseCandidate[],
  evidence: string[]
): RootCauseCandidate[] {
  const joined = evidence.join(" ");
  // Distinctive stems of the collected evidence, used to decide whether an
  // LLM-generated (unanchored) candidate has ANY grounding in what we observed.
  const evidenceStems = distinctiveStems(joined);
  const port5938Open = /tcp\s+5938\s+reachability:\s*\d+\/\d+[^\n]*?\bok\b/i.test(joined);
  const endpointTcpOk = /endpoint\s+tcp\s+reachability:\s*([1-9]\d*)\/\d+[^\n]*?\bok\b/i.test(joined);
  const dnsOk = /dns\s+resolved\s+([1-9]\d*)\/\d+\s+teamviewer\s+hosts/i.test(joined);
  const firewallRuledOut = dnsOk && (port5938Open || endpointTcpOk);
  // We injected a CAVEAT line for stale-CA-bundle probe issues. If it's
  // present, the TLS validation failure is a probe-host hygiene issue, NOT a
  // user-symptom cause — drop any rootCause the LLM synthesised about it.
  const tlsCaveatPresent = /local\s+certificate-validation\s+issue\s+on\s+the\s+probe\s+host/i.test(joined);
  // "Processes running: TeamViewer, TeamViewer_Service, ..." — the daemon IS
  // running, regardless of whether a launchd plist is registered.
  const teamviewerServiceRunning =
    /processes\s+running:[^\n]*\bteamviewer_service\b/i.test(joined) ||
    /processes\s+running:[^\n]*\bteamviewerd\b/i.test(joined);

  return roots.filter((r) => {
    const text = `${r.title} ${r.rationale ?? ""}`.toLowerCase();
    const rationale = (r.rationale ?? "").toLowerCase();
    // Drop placeholder garbage the small LLM emits in place of a real
    // candidate (e.g. title="..." rationale="..."). A real root cause has a
    // noun-phrase title with at least a few letters of actual content.
    const titleClean = (r.title ?? "").trim();
    if (titleClean.length < 6) return false;
    if (!/[a-z]{4,}/i.test(titleClean)) return false;
    // EVIDENCE-ANCHOR GATE (the core reliability rule): an LLM-generated
    // candidate (evidenceAnchored === false) must share at least one
    // distinctive stem with the collected evidence, otherwise it's pure
    // speculation ("Permissions Issue" with no permission signal anywhere).
    // Probe-derived candidates (evidenceAnchored === true) are exempt — they
    // ARE the evidence. Candidates with no provenance flag (undefined, e.g.
    // direct callers / tests) are also exempt to preserve backward behaviour.
    if (r.evidenceAnchored === false && !hasEvidenceAnchor(r, evidenceStems)) {
      return false;
    }
    const mentionsFirewall = /firewall/.test(text);
    if (mentionsFirewall) {
      if (port5938Open && /\b5938\b/.test(text)) return false;
      if (firewallRuledOut && /teamviewer|traffic|blocking|outgoing|inbound|connectivity|network/.test(text)) return false;
    }
    // Generic "unstable network / connectivity issue" titled cause whose
    // rationale just blames the firewall — same trap, no "firewall" in title.
    if (firewallRuledOut && /\b(unstable\s+network|network\s+connectivity|connection\s+drop)/.test(text) && /firewall|blocking|inbound|outbound/.test(text)) {
      return false;
    }
    // CA bundle / TLS validation as a CAUSE of the user's symptom — already
    // explained as a probe-host hygiene issue by the evidence caveat.
    if (tlsCaveatPresent && /(ca\s+bundle|certificate\s+authority|tls\s+validation|cert\s+(chain|validation)|outdated\s+root\s+store)/.test(text)) {
      return false;
    }
    // "TeamViewer (background )?service not (registered|running)" / "daemon
    // (not )?registered" / generic "TeamViewer Service issue|problem|fault"
    // — falsified by the process list. Match generously: any title that
    // says TeamViewer + service|daemon|background + a negative-state word.
    if (teamviewerServiceRunning && /teamviewer/.test(text) && /\b(service|daemon|background)\b/.test(text) && /(not\s+(registered|running|started|active|configured)|issue|problem|fault|trouble|malfunction|error|broken|stopped|crashed|crash|fail|fails|down|misconfigured|disabled|missing|absent|removed|uninstalled)/.test(text)) {
      return false;
    }
    // Absence-of-evidence is NOT a root cause. The small LLM happily writes
    // rationales like "Based on the lack of TeamViewer-related log files and
    // the absence of any TeamViewer-specific events in the event log" — that's
    // a reason we COULDN'T conclude, not a reason the user's symptom exists.
    if (/^(based on the )?(lack|absence|missing|no\s+(log|trace|record|event)|did not (find|see|detect)|cannot (find|see|determine))/i.test(rationale.trim())) {
      return false;
    }
    if (/\b(lack of|absence of|no .*(found|present)|missing .* (log|trace|record))\b/i.test(rationale) && rationale.length < 200) {
      return false;
    }
    // UI / interface causes are out-of-scope for connectivity / endpoint /
    // log specialists — the small model invents them when it has nothing else
    // to say. None of our probes can measure UI state, so we never have
    // grounded evidence for them.
    if (/\b(user\s+interface|ui\s+(issue|problem|setting|configuration)|interface\s+(issue|problem|setting|configuration|hindering))\b/.test(text)) {
      return false;
    }
    // Imperative / action-shaped "root causes" — the LLM rerank loves to
    // promote remediation steps ("Check the system logs for any errors",
    // "Restart the TeamViewer service", "Verify network settings") into the
    // root-cause list. Those are ACTIONS, not causes. A real root-cause
    // title is a noun phrase ("Outdated TeamViewer client", "Corporate DNS
    // hijack"), not a verb phrase. Drop titles that start with an
    // imperative verb.
    const titleHead = r.title.trim().toLowerCase();
    if (/^(check|verify|inspect|restart|reinstall|update|upgrade|enable|disable|configure|reconfigure|investigate|review|monitor|ensure|run|execute|examine|test|confirm|validate|collect|gather|capture|contact|escalate|reboot|reset|clear|flush|remove|delete|install|apply|change|modify|adjust)\b/.test(titleHead)) {
      return false;
    }
    return true;
  });
}

/**
 * Hypotheses share the SAME evidence as root causes — if a hypothesis is
 * already disproven ("firewall might block" when DNS+TCP just passed), drop
 * it. Also dedupes near-identical hypotheses (the LLM emits multiple
 * paraphrases of "firewall blocks TeamViewer" per run).
 */
export function filterHypothesesAgainstEvidence(
  hypotheses: string[],
  evidence: string[]
): string[] {
  const joined = evidence.join(" ");
  const port5938Open = /tcp\s+5938\s+reachability:\s*\d+\/\d+[^\n]*?\bok\b/i.test(joined);
  const endpointTcpOk = /endpoint\s+tcp\s+reachability:\s*([1-9]\d*)\/\d+[^\n]*?\bok\b/i.test(joined);
  const dnsOk = /dns\s+resolved\s+([1-9]\d*)\/\d+\s+teamviewer\s+hosts/i.test(joined);
  const firewallRuledOut = dnsOk && (port5938Open || endpointTcpOk);
  const tlsCaveatPresent = /local\s+certificate-validation\s+issue\s+on\s+the\s+probe\s+host/i.test(joined);
  const teamviewerServiceRunning =
    /processes\s+running:[^\n]*\bteamviewer_service\b/i.test(joined) ||
    /processes\s+running:[^\n]*\bteamviewerd\b/i.test(joined);

  // Normalise for dedup: strip filler words + punctuation + lowercase.
  const norm = (s: string): string =>
    s
      .toLowerCase()
      .replace(/[\p{P}\p{S}]+/gu, " ")
      .replace(/\b(the|a|an|might|could|may|be|is|are|of|to|in|on|that|this|some|any|there|might|will|would|should)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const seen = new Set<string>();

  const kept: string[] = [];
  for (const raw of hypotheses) {
    const text = raw.toLowerCase();
    // When DNS+TCP both pass, ANY firewall hypothesis is noise \u2014 the probes
    // already proved the firewall is not in the path. Be aggressive: there's
    // no useful firewall hypothesis to keep in this state.
    if (firewallRuledOut && /firewall/.test(text)) continue;
    if (firewallRuledOut && /\b(dns)\b/.test(text) && /resolution|issue|problem|fail/.test(text)) continue;
    if (tlsCaveatPresent && /(ca\s+bundle|certificate\s+authority|tls\s+validation|outdated\s+root\s+store)/.test(text)) continue;
    // Service-running hypotheses are noise when the process list shows
    // teamviewer_service / teamviewerd. Match generously: "TeamViewer
    // service might be misconfigured" / "preventing the TeamViewer Service
    // from starting" / "TeamViewer daemon may be down".
    if (teamviewerServiceRunning && /teamviewer/.test(text) && /\b(service|daemon|background)\b/.test(text) && /(misconfigured|broken|not\s+running|crash|down|disabled|prevent|fail\s+to\s+start|cannot\s+start|missing|absent|removed|uninstalled|deleted|gone|issue|problem|fault|trouble|malfunction|error|stopped|crashed|fails)/.test(text)) continue;
    // UI hypotheses are out-of-scope (no UI probe) — always drop them.
    if (/\b(user\s+interface|ui\s+(issue|problem|setting|configuration)|interface\s+(issue|problem|setting|configuration|hindering))\b/.test(text)) continue;
    // Imperative-form "hypotheses" are actually action recommendations
    // ("Check network connection between the Mac and the target IP.",
    // "Inspect for any recent changes…", "Verify firewall settings").
    // Drop them so the Hypotheses block stays a list of *causes*.
    if (/^(check|verify|inspect|restart|reinstall|update|upgrade|enable|disable|configure|reconfigure|investigate|review|monitor|ensure|run|execute|examine|test|confirm|validate|collect|gather|capture|contact|escalate|reboot|reset|clear|flush|remove|delete|install|apply|change|modify|adjust|look\s+(into|for|at)|make\s+sure)\b/.test(text.trim())) continue;
    const key = norm(raw);
    if (!key) continue;
    if (seen.has(key)) continue;
    // Also drop substring duplicates (one normalised key is contained in another).
    if (Array.from(seen).some((k) => k.includes(key) || key.includes(k))) continue;
    seen.add(key);
    kept.push(raw);
  }
  return kept.slice(0, 8);
}

/**
 * Drops actions whose recommendation is directly contradicted by probe
 * evidence we already collected. Currently focused on firewall actions:
 * if DNS resolves AND TCP to TeamViewer hosts succeeds, the firewall is
 * NOT blocking — even if higher-layer probes (HTTPS, cert validation) fail
 * for unrelated reasons (e.g. expired CA bundle on macOS Monterey).
 */
export function filterActionsAgainstEvidence(
  actions: ActionItem[],
  evidence: string[]
): ActionItem[] {
  const joined = evidence.join(" ");
  // "TCP 5938 reachability: 3/3 routers OK" — routers reachable on 5938.
  const port5938Open = /tcp\s+5938\s+reachability:\s*\d+\/\d+[^\n]*?\bok\b/i.test(joined);
  // "TeamViewer Remote endpoint TCP reachability: 9/9 OK" — product endpoints reachable.
  const endpointTcpOk = /endpoint\s+tcp\s+reachability:\s*([1-9]\d*)\/\d+[^\n]*?\bok\b/i.test(joined);
  // "DNS resolved 6/6 TeamViewer hosts" — name resolution works.
  const dnsOk = /dns\s+resolved\s+([1-9]\d*)\/\d+\s+teamviewer\s+hosts/i.test(joined);
  // Firewall is definitively NOT the problem when DNS + TCP both work.
  // (HTTPS may still fail for cert / proxy / TLS reasons — not firewall.)
  const firewallRuledOut = dnsOk && (port5938Open || endpointTcpOk);
  // TeamViewer service/daemon is RUNNING when we see its process in the
  // process list. The endpoint-health specialist sometimes recommends
  // `launchctl load teamviewerd` purely because no launchd job was registered
  // — but on modern macOS TeamViewer 15 runs as a regular app and the daemon
  // job is optional; the service IS running.
  const teamviewerServiceRunning =
    /processes\s+running:[^\n]*\bteamviewer_service\b/i.test(joined) ||
    /processes\s+running:[^\n]*\bteamviewerd\b/i.test(joined);

  return actions.filter((a) => {
    const text = `${a.step} ${a.rollback ?? ""} ${a.command ?? ""}`.toLowerCase();
    // Drop placeholder garbage the small LLM emits (".", "...", "-", empty
    // step content). Anything < 10 chars OR composed solely of punctuation
    // is not a real recommendation.
    const stepClean = (a.step ?? "").trim();
    if (stepClean.length < 10) return false;
    if (!/[a-z]{4,}/i.test(stepClean)) return false;
    const mentionsFirewall = /firewall/.test(text);
    if (mentionsFirewall) {
      // Two carve-outs that prevent legitimate actions from being dropped:
      //  (a) probe-hygiene CA ("do not change the host firewall")
      //  (b) diagnostic context \u2014 if the action recommends running a
      //      packet-capture / ping / traceroute / DNS-resolver tool, any
      //      firewall mention is a parenthetical aside (e.g. "check NAT/
      //      firewall idle-timeout") rather than a blocking-style change.
      const isProbeHygieneCarveOut = /do not change the host firewall/.test(text) || /probe hygiene/.test(text);
      const isDiagnosticContext = /\b(tcpdump|pktmon|wireshark|ping\b|traceroute|mtr\b|dig\b|nslookup|scutil|netstat|ss\s+-|capture\s+a?\s*\d*\s*(min|sec)|packet\s+capture)\b/.test(text);
      const isBlockingRecommendation = /\b(block|blocking|blocked|allow|allow-?list|whitelist|open\s+(?:the\s+)?port|firewall\s+(?:rule|setting|configuration|config)|deny|denies|inbound\s+rule|outbound\s+rule)\b/.test(text);
      if (!isProbeHygieneCarveOut && !isDiagnosticContext) {
        // Action explicitly inspects the firewall for a port we just proved open.
        if (port5938Open && /\b5938\b/.test(text)) return false;
        // Generic "firewall blocking TeamViewer traffic" / "firewall rules" \u2014
        // if DNS + TCP work, blocking-class firewall recommendations are
        // contradicted by the evidence.
        if (firewallRuledOut && isBlockingRecommendation) return false;
      }
    }
    // "sudo launchctl load -w .../com.teamviewer.teamviewerd.plist" or any
    // "start the background service teamviewerd" recommendation — only valid
    // when the service is NOT already running.
    if (
      teamviewerServiceRunning &&
      /\b(launchctl|launchd|background\s+service|start\s+service|service\s+is\s+not\s+running)\b/.test(text) &&
      /teamviewer/.test(text)
    ) {
      return false;
    }
    // Drop "verify UI settings" / "check user interface" actions — we have
    // no UI probe, so any UI recommendation is an LLM guess paired with a
    // hallucinated UI root cause (which we also drop above).
    if (/\b(user\s+interface|ui\s+(settings|configuration|compatibility|issue))\b/.test(text)) {
      return false;
    }
    // Dedupe LLM-generated bare-CA-bundle actions when the canonical
    // probe-hygiene action is already in the list (deduplicateActions only
    // catches exact step matches; the LLM rewords).
    if (/update\s+(the\s+)?(system'?s?\s+)?ca\s+bundle/.test(text) && !/\(probe\s+hygiene/.test(text)) {
      return false;
    }
    return true;
  });
}

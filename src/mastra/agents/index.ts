import { Agent } from "@mastra/core/agent";
import {
  authPolicyTool,
  connectivityTool,
  endpointHealthTool,
  logIntelligenceTool
} from "../tools/specialistTools.js";
import { teamviewerDocsTool } from "../tools/knowledgeTool.js";

const DOCS_INSTRUCTION =
  " When unsure about TeamViewer specifics (ports, Web API endpoints, services, product capabilities), call the tw-official-docs tool to read the official documentation. If it returns confident=false, do not invent an answer — tell the user the verified facts you have and point them to the cited official URL.";
import { isLoopbackEndpoint, normalizeModelId, discoverFoundryEndpoint } from "../foundryLocal.js";
import { getActiveModelId } from "../../userConfig.js";

interface ResolvedModelConfig {
  providerId: "openai";
  modelId: string;
  url: string;
  apiKey: string;
}

let cachedModel: ResolvedModelConfig | null = null;
let warnedDefaultKey = false;

/** Invalidate the cached config so the next agent call picks up a new model id. */
export function invalidateModelCache(): void {
  cachedModel = null;
}

/**
 * Lazily resolve the Foundry Local model config. Throws only when invoked,
 * so non-LLM CLI commands (products, jobs list, etc.) keep working when the
 * runtime is offline or env vars are missing.
 */
export function resolveModel(): ResolvedModelConfig {
  if (cachedModel) {
    return cachedModel;
  }

  const configuredModelId = getActiveModelId();
  if (!configuredModelId) {
    throw new Error(
      "No active model. Run 'twc models list' and 'twc models use <id-or-alias>', or set FOUNDRY_LOCAL_MODEL."
    );
  }

  const endpoint = discoverFoundryEndpoint();
  if (!endpoint) {
    throw new Error(
      "Missing local LLM endpoint. Set FOUNDRY_LOCAL_ENDPOINT (or run 'foundry service start') to enable LLM features."
    );
  }
  if (!isLoopbackEndpoint(endpoint)) {
    throw new Error(
      `Invalid local endpoint '${endpoint}'. Foundry Local mode allows only localhost/127.0.0.1/::1 endpoints.`
    );
  }

  const apiKey = process.env.FOUNDRY_LOCAL_API_KEY ?? process.env.OPENAI_API_KEY ?? "local-dev-key";
  if (apiKey === "local-dev-key" && !warnedDefaultKey) {
    warnedDefaultKey = true;
    console.warn(
      "[twc] Using default placeholder API key. Set FOUNDRY_LOCAL_API_KEY explicitly to silence this warning."
    );
  }

  cachedModel = {
    providerId: "openai",
    modelId: normalizeModelId(configuredModelId),
    url: endpoint,
    apiKey
  };
  return cachedModel;
}

/** Mastra Agent accepts a function returning the config so import-time never throws. */
const modelGetter = () => resolveModel();

export const gatewayAgent = new Agent({
  id: "tw-gateway-agent",
  name: "TeamViewer Gateway Agent",
  instructions:
    "You coordinate TeamViewer troubleshooting. Classify issues, route to specialists, and synthesize final analysis. Reply concisely and follow output format requested by the caller." +
    DOCS_INSTRUCTION,
  model: modelGetter,
  tools: { teamviewerDocsTool }
});

/**
 * Strictly-grounded composer for `docs ask`. It has NO tools and is constrained
 * to answer only from the CONTEXT passed in the prompt — the retrieval is done
 * by our LanceDB hybrid retriever, this agent only rephrases what was retrieved.
 * Output is verified sentence-by-sentence by the caller before being shown.
 */
export const docsComposerAgent = new Agent({
  id: "tw-docs-composer",
  name: "TeamViewer Docs Composer",
  instructions:
    "You answer TeamViewer questions using ONLY the CONTEXT passages provided in the prompt. " +
    "Rules: (1) Use ONLY facts explicitly present in the CONTEXT — never add information, examples, " +
    "marketing copy, or product names that are not in the CONTEXT. " +
    "(2) If the CONTEXT does not contain the answer, reply with exactly NOT_IN_CONTEXT and nothing else. " +
    "(3) Be concise and factual: 1 to 4 sentences. " +
    "(4) Do NOT include URLs, citations, or markdown — the system adds sources separately.",
  model: modelGetter
});

export const connectivityAgent = new Agent({
  id: "tw-connectivity-agent",
  name: "TeamViewer Connectivity Agent",
  instructions:
    "You diagnose TeamViewer connectivity problems: VPN, DNS, firewall, routing, packet loss. Use the connectivity tool to gather baseline evidence, then prioritize hypotheses for the user's specific issue." +
    DOCS_INSTRUCTION,
  model: modelGetter,
  tools: { connectivityTool, teamviewerDocsTool }
});

export const authPolicyAgent = new Agent({
  id: "tw-auth-policy-agent",
  name: "TeamViewer Auth Policy Agent",
  instructions:
    "You diagnose TeamViewer auth/SSO/token/policy issues. Use the auth-policy tool for baseline, then prioritize hypotheses." +
    DOCS_INSTRUCTION,
  model: modelGetter,
  tools: { authPolicyTool, teamviewerDocsTool }
});

export const endpointHealthAgent = new Agent({
  id: "tw-endpoint-health-agent",
  name: "TeamViewer Endpoint Health Agent",
  instructions:
    "You diagnose endpoint runtime health, service state, version compatibility and host resources. Use the endpoint-health tool first, then enrich." +
    DOCS_INSTRUCTION,
  model: modelGetter,
  tools: { endpointHealthTool, teamviewerDocsTool }
});

export const logIntelligenceAgent = new Agent({
  id: "tw-log-intelligence-agent",
  name: "TeamViewer Log Intelligence Agent",
  instructions:
    "You analyze incident logs and identify repeating failure signatures. Use the log-intelligence tool to seed analysis, then surface deterministic clusters." +
    DOCS_INSTRUCTION,
  model: modelGetter,
  tools: { logIntelligenceTool, teamviewerDocsTool }
});

export const specialistAgents = {
  connectivity: connectivityAgent,
  "auth-policy": authPolicyAgent,
  "endpoint-health": endpointHealthAgent,
  "log-intelligence": logIntelligenceAgent
} as const;

export type SpecialistKey = keyof typeof specialistAgents;

import { ensureFoundryLocalReady } from "../mastra/foundryLocal.js";
import { docsComposerAgent } from "../mastra/agents/index.js";
import {
  retrieveKnowledgeHits,
  embedTexts,
  cosineSimilarity,
  bestSourceFor,
  type KnowledgeAnswer,
  type KnowledgeHit
} from "./teamviewerDocs.js";

/**
 * Per-sentence grounding threshold. A generated sentence is kept only if its
 * cosine similarity to at least one retrieved context chunk is >= this value.
 * Lower = more permissive (risk of drift), higher = stricter (risk of dropping
 * valid paraphrases). Tunable via TWC_GROUND_MIN. Default 0.45.
 */
const GROUND_MIN = Math.max(0, Math.min(1, Number(process.env.TWC_GROUND_MIN) || 0.45));

/** How many retrieved hits are handed to the model as CONTEXT. */
const CONTEXT_HITS = 5;

const DECLINE = "The available documentation does not contain a verified answer to that question.";

function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Anchor source first, then any other source actually retrieved — never invented. */
function orderedCitations(hits: KnowledgeHit[]): string[] {
  if (hits.length === 0) return [];
  return Array.from(new Set([hits[0].source, ...hits.map((h) => h.source)])).slice(0, 3);
}

/**
 * Keep only the answer sentences that are semantically supported by the
 * retrieved context. This is the anti-hallucination gate: any sentence the
 * model produced that does not align with a real chunk is dropped. It is NOT a
 * fallback to extractive text — unsupported content is simply removed.
 */
async function verifyGrounding(answer: string, contextTexts: string[]): Promise<string> {
  const sentences = splitSentences(answer);
  if (sentences.length === 0 || contextTexts.length === 0) return "";
  const { vectors } = await embedTexts([...sentences, ...contextTexts]);
  const sentVecs = vectors.slice(0, sentences.length);
  const ctxVecs = vectors.slice(sentences.length);
  const kept = sentences.filter((_, i) => ctxVecs.some((cv) => cosineSimilarity(sentVecs[i], cv) >= GROUND_MIN));
  return kept.join(" ");
}

/**
 * LLM-grounded answer for `docs ask` (default path).
 *
 * Foundry Local is MANDATORY — if it is not reachable this throws (hard gate,
 * no extractive fallback, consistent with the rest of the project). Retrieval
 * is done by our tuned LanceDB hybrid retriever; the local model only rephrases
 * the retrieved CONTEXT, and every sentence is then verified against that
 * context with the embedding model. Citations come only from the real
 * retrieved sources.
 */
export async function answerGrounded(query: string): Promise<KnowledgeAnswer> {
  await ensureFoundryLocalReady();

  const { hits } = await retrieveKnowledgeHits(query);
  if (hits.length === 0) {
    const src = bestSourceFor(query);
    return { answer: DECLINE, confident: false, citations: [src.url], hits };
  }

  const context = hits.slice(0, CONTEXT_HITS);
  const contextBlock = context.map((h, i) => `[${i + 1}] ${h.title ?? h.source}\n${h.text}`).join("\n\n");
  const prompt =
    `CONTEXT:\n${contextBlock}\n\n` +
    `QUESTION: ${query}\n\n` +
    "Answer the QUESTION using ONLY the CONTEXT above. " +
    "If the CONTEXT does not contain the answer, reply with exactly NOT_IN_CONTEXT.";

  const out = await docsComposerAgent.generate(prompt);
  const raw = (out.text ?? "").trim();
  if (!raw || /NOT_IN_CONTEXT/i.test(raw)) {
    return { answer: DECLINE, confident: false, citations: orderedCitations(hits), hits };
  }

  const verified = await verifyGrounding(
    raw,
    context.map((h) => h.text)
  );
  if (!verified) {
    return { answer: DECLINE, confident: false, citations: orderedCitations(hits), hits };
  }

  return { answer: verified, confident: true, citations: orderedCitations(hits), hits };
}

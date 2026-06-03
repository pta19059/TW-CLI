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

/** How many retrieved hits are handed to the model as CONTEXT.
 *
 * Foundry Local runs small models on a local NPU, where *prompt processing*
 * (ingesting the CONTEXT) dominates latency far more than token generation. A
 * large grounded context (5 hits x ~1200 chars) can push a single `docs ask`
 * into multiple minutes. We therefore keep the LLM context tight by default and
 * make it tunable via TWC_CONTEXT_HITS. Retrieval and citations are unaffected;
 * only what the model has to read is trimmed. */
const CONTEXT_HITS = Math.max(1, Number(process.env.TWC_CONTEXT_HITS) || 3);

/** Per-hit character budget for the text shown to the model. Trimming each
 * chunk keeps prompt-processing fast on a local NPU. Grounding still runs
 * against the same trimmed text, so citations stay honest. Tunable via
 * TWC_CONTEXT_CHARS. */
const CONTEXT_CHARS = Math.max(120, Number(process.env.TWC_CONTEXT_CHARS) || 600);

const DECLINE = "The available documentation does not contain a verified answer to that question.";

function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    // Small models often loop and glue sentences with no separator
    // (e.g. "...delivery.TeamViewer ONE..."). Insert a space after sentence
    // punctuation when it is immediately followed by a capital letter so the
    // splitter below can separate (and the dedup can collapse) the repeats.
    .replace(/([.!?])(?=[A-Z])/g, "$1 ")
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
  // Small local models frequently loop, emitting the same sentence many times.
  // Drop near-identical repeats (case/space-insensitive) so the answer reads
  // once. Order is preserved; only later duplicates are removed.
  const seen = new Set<string>();
  const deduped = kept.filter((s) => {
    const key = s.toLowerCase().replace(/\s+/g, " ").trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return deduped.join(" ");
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
  // Trim each chunk to keep the prompt small: on a local NPU, prompt processing
  // is the dominant cost. Grounding runs against these same trimmed texts.
  const contextTexts = context.map((h) => h.text.slice(0, CONTEXT_CHARS));
  const contextBlock = context
    .map((h, i) => `[${i + 1}] ${h.title ?? h.source}\n${contextTexts[i]}`)
    .join("\n\n");
  const prompt =
    `CONTEXT:\n${contextBlock}\n\n` +
    `QUESTION: ${query}\n\n` +
    "Answer the QUESTION using ONLY the CONTEXT above. " +
    "If the CONTEXT does not contain the answer, reply with exactly NOT_IN_CONTEXT.";

  // Foundry Local is a slow local NPU server: it withholds the HTTP response
  // headers until the first token is computed, so a large grounded prompt can
  // blow past undici's default headers timeout (UND_ERR_HEADERS_TIMEOUT). The
  // real fix lives in runtime/bootstrap.ts, which disables undici's
  // headers/body timeouts globally. On top of that we bound generation here:
  //  - maxOutputTokens keeps the answer short (instructions ask for 1-4
  //    sentences) and, crucially, prevents a small model from running away into
  //    a multi-minute / looping generation.
  //  - temperature 0 makes the grounded rephrase deterministic.
  // Streaming is kept so we accumulate tokens as they arrive; we still await the
  // fully accumulated text before grounding.
  const out = await docsComposerAgent.stream(prompt, {
    modelSettings: { maxOutputTokens: 160, temperature: 0 }
  });
  const raw = ((await out.text) ?? "").trim();
  if (!raw || /NOT_IN_CONTEXT/i.test(raw)) {
    return { answer: DECLINE, confident: false, citations: orderedCitations(hits), hits };
  }

  const verified = await verifyGrounding(raw, contextTexts);
  if (!verified) {
    return { answer: DECLINE, confident: false, citations: orderedCitations(hits), hits };
  }

  return { answer: verified, confident: true, citations: orderedCitations(hits), hits };
}

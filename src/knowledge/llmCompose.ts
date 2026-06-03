import { ensureFoundryLocalReady } from "../mastra/foundryLocal.js";
import { docsComposerAgent } from "../mastra/agents/index.js";
import {
  retrieveKnowledgeHits,
  embedTexts,
  cosineSimilarity,
  bestSourceFor,
  stripPromoFooter,
  isJunkChunk,
  type KnowledgeAnswer,
  type KnowledgeHit
} from "./teamviewerDocs.js";

/**
 * Per-sentence grounding threshold. A generated sentence is kept only if its
 * cosine similarity to at least one retrieved context chunk is >= this value.
 * Lower = more permissive (risk of drift), higher = stricter (risk of dropping
 * valid paraphrases). Tunable via TWC_GROUND_MIN. Default 0.40 — small local
 * models paraphrase heavily, so a slightly looser gate keeps faithful
 * restatements of the CONTEXT instead of dropping them (which previously left
 * an empty answer and forced an unwarranted DECLINE).
 */
const GROUND_MIN = Math.max(0, Math.min(1, Number(process.env.TWC_GROUND_MIN) || 0.4));

/** How many retrieved hits are handed to the model as CONTEXT.
 *
 * Foundry Local runs small models on a local NPU, where *prompt processing*
 * (ingesting the CONTEXT) dominates latency far more than token generation. A
 * large grounded context can push a single `docs ask` into multiple minutes on
 * an NPU. On the CPU build (current default) prompt processing is far cheaper,
 * so we hand the model MORE grounded passages by default to maximise the chance
 * the answer is actually present — robustness over raw speed. Tunable via
 * TWC_CONTEXT_HITS. Retrieval and citations are unaffected; only what the model
 * has to read changes. */
const CONTEXT_HITS = Math.max(1, Number(process.env.TWC_CONTEXT_HITS) || 5);

/** Per-hit character budget for the text shown to the model. Chunks are built
 * at ~1200 chars (a single coherent passage), so the default now shows the
 * WHOLE chunk: trimming to half a chunk frequently cut the sentence carrying
 * the answer, leaving the model with only a boilerplate prefix and forcing a
 * spurious NOT_IN_CONTEXT. Grounding still runs against this same text, so
 * citations stay honest. Tunable via TWC_CONTEXT_CHARS. */
const CONTEXT_CHARS = Math.max(120, Number(process.env.TWC_CONTEXT_CHARS) || 1200);

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

/**
 * Build citations from ONLY the context hits that actually grounded the
 * answer. Previously we cited every retrieved hit (sliced to 3), so passages
 * the model never used — e.g. an unrelated "which ports" article surfacing on a
 * "What is TeamViewer ONE?" query — leaked into Sources. We now pass the
 * specific hits whose text supported a verified sentence; order is preserved
 * and duplicate sources collapse. Falls back to the top hit only when nothing
 * grounded (so Sources is never empty on a confident answer).
 */
function orderedCitations(groundedHits: KnowledgeHit[], allHits: KnowledgeHit[]): string[] {
  const source = groundedHits.length > 0 ? groundedHits : allHits.slice(0, 1);
  if (source.length === 0) return [];
  return Array.from(new Set(source.map((h) => h.source))).slice(0, 3);
}

/**
 * Small local models frequently keep generating after they have answered,
 * looping back to restate an earlier phrase (e.g. a ports answer ends
 * "...port 80 TCP/UDP port 5938", repeating the opening). Remove the longest
 * trailing run of >=3 words that already appears earlier in the text, repeating
 * until the tail is original. Conservative (>=3 words, verbatim match) so it
 * only strips genuine loop repeats, never distinct content.
 */
function collapseLoopedTail(text: string): string {
  const words = text.split(/\s+/).filter(Boolean);
  for (let len = Math.floor(words.length / 2); len >= 3; len--) {
    const tail = words.slice(words.length - len).join(" ");
    const head = words.slice(0, words.length - len).join(" ").trim();
    if (head.includes(tail)) return collapseLoopedTail(head);
  }
  return text;
}

/**
 * Keep only the answer sentences that are semantically supported by the
 * retrieved context. This is the anti-hallucination gate: any sentence the
 * model produced that does not align with a real chunk is dropped. It is NOT a
 * fallback to extractive text — unsupported content is simply removed.
 */
async function verifyGrounding(
  answer: string,
  contextTexts: string[]
): Promise<{ text: string; groundedIdx: Set<number> }> {
  const empty = { text: "", groundedIdx: new Set<number>() };
  const sentences = splitSentences(answer);
  if (sentences.length === 0 || contextTexts.length === 0) return empty;
  const { vectors } = await embedTexts([...sentences, ...contextTexts]);
  const sentVecs = vectors.slice(0, sentences.length);
  const ctxVecs = vectors.slice(sentences.length);
  // Track which context chunks actually supported a kept sentence so callers
  // can cite ONLY those sources (not every retrieved hit).
  const groundedIdx = new Set<number>();
  const kept = sentences.filter((_, i) => {
    let supported = false;
    ctxVecs.forEach((cv, ci) => {
      if (cosineSimilarity(sentVecs[i], cv) >= GROUND_MIN) {
        supported = true;
        groundedIdx.add(ci);
      }
    });
    return supported;
  });
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
  return { text: collapseLoopedTail(deduped.join(" ")), groundedIdx };
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
  // Build the CONTEXT the model reads (and grounds against) with the recurring
  // marketing/navigation footer removed. ~66% of KB pages carry an identical
  // "## TeamViewer ONE … Key integrations: Microsoft Intune, ServiceNow, …"
  // promo block; left in, a small model paraphrases it and grounding then
  // matches it across every footer-bearing page, so unrelated articles leaked
  // into Sources. Stripping the footer (and dropping chunks that are pure
  // footer) means the model only ever sees real article prose, so citations
  // reflect the passages that actually answered the question.
  const candidates = context
    .map((h) => ({ hit: h, text: stripPromoFooter(h.text).slice(0, CONTEXT_CHARS).trim() }))
    .filter((c) => c.text.length > 0 && !isJunkChunk(c.hit.text));
  if (candidates.length === 0) {
    return { answer: DECLINE, confident: false, citations: orderedCitations([], hits), hits };
  }
  const contextHits = candidates.map((c) => c.hit);
  const contextTexts = candidates.map((c) => c.text);
  const contextBlock = contextTexts
    .map((t, i) => `[${i + 1}] ${contextHits[i].title ?? contextHits[i].source}\n${t}`)
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
  //  - maxOutputTokens caps the answer (a few sentences) and, crucially,
  //    prevents a small model from running away into a multi-minute / looping
  //    generation.
  //  - temperature 0 makes the grounded rephrase deterministic.
  // Streaming is kept so we accumulate tokens as they arrive; we still await the
  // fully accumulated text before grounding.
  const out = await docsComposerAgent.stream(prompt, {
    modelSettings: { maxOutputTokens: 256, temperature: 0 }
  });
  const raw = ((await out.text) ?? "").trim();
  // Small local models often (a) glue a number to the next token ("5938TCP")
  // and (b) keep generating AFTER answering, emitting a stray NOT_IN_CONTEXT
  // marker in the middle of a perfectly good answer. A naive substring test for
  // NOT_IN_CONTEXT therefore threw away correct answers. We instead de-glue
  // digit→capital boundaries, strip every NOT_IN_CONTEXT marker, and DECLINE
  // only when nothing substantive is left — i.e. the model genuinely refused.
  const cleaned = raw
    // Small models sometimes wrap output in markdown code fences (```json …```)
    // despite being told not to; strip balanced and dangling fences and any
    // stray backticks so the answer is plain prose.
    .replace(/```[a-z]*\r?\n?[\s\S]*?```/gi, " ")
    .replace(/```[a-z]*/gi, " ")
    .replace(/`+/g, " ")
    .replace(/([0-9])([A-Z])/g, "$1 $2")
    .replace(/NOT[_ ]?IN[_ ]?CONTEXT/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!cleaned) {
    return { answer: DECLINE, confident: false, citations: orderedCitations([], hits), hits };
  }

  const { text: verified, groundedIdx } = await verifyGrounding(cleaned, contextTexts);
  if (!verified) {
    return { answer: DECLINE, confident: false, citations: orderedCitations([], hits), hits };
  }

  // Cite ONLY the context chunks that actually grounded a verified sentence, in
  // their original retrieval order — so unrelated retrieved passages never leak
  // into Sources.
  const groundedHits = contextHits.filter((_, i) => groundedIdx.has(i));
  return { answer: verified, confident: true, citations: orderedCitations(groundedHits, hits), hits };
}

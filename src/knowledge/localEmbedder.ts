// ────────────────────────────────────────────────────────────────────────────
// Local ONNX embedder
//
// Runs a small sentence-embedding model fully in-process via Transformers.js
// (onnxruntime under the hood). This is the embedding engine for the hybrid RAG
// index: it is 100% local, free, deterministic and works offline once the model
// is cached. Foundry Local cannot serve embeddings (its catalog ships only
// chat-completion models), so embeddings run here instead.
//
// The model is downloaded once from the Hugging Face hub into the Transformers.js
// cache (~/.cache or the platform default) and reused thereafter. Override the
// model id with TWC_EMBED_MODEL.
// ────────────────────────────────────────────────────────────────────────────

import type { FeatureExtractionPipeline } from "@huggingface/transformers";

/** Default local embedding model — small (~90 MB), 384-dim, ONNX, no key. */
export const DEFAULT_EMBED_MODEL = "Xenova/all-MiniLM-L6-v2";

export function embedModelId(): string {
  return process.env.TWC_EMBED_MODEL || DEFAULT_EMBED_MODEL;
}

let pipelinePromise: Promise<FeatureExtractionPipeline> | undefined;
let loadedModel: string | undefined;

/**
 * onnxruntime (native) and Transformers.js emit a few harmless one-time warnings
 * to stderr on ARM64 — e.g. "Error in cpuinfo: Unknown chip model name
 * 'Snapdragon...'" and "dtype not specified...". They do not affect results
 * (onnxruntime falls back to a generic CPU path). We filter exactly these known
 * lines so the CLI output stays clean; everything else passes through untouched.
 */
const NOISE = /cpuinfo|Windows on Arm SoC|arm[\\/]windows[\\/]init\.c|dtype not specified/i;
let stderrPatched = false;
function silenceHarmlessEmbedderWarnings(): void {
  if (stderrPatched) return;
  stderrPatched = true;
  const original = process.stderr.write.bind(process.stderr);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = (chunk: any, encoding?: any, callback?: any): boolean => {
    try {
      const text = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : "";
      if (text && NOISE.test(text)) {
        if (typeof encoding === "function") encoding();
        else if (typeof callback === "function") callback();
        return true;
      }
    } catch {
      /* fall through to the real write */
    }
    return original(chunk, encoding, callback);
  };
}

async function getExtractor(): Promise<FeatureExtractionPipeline> {
  const model = embedModelId();
  if (!pipelinePromise || loadedModel !== model) {
    loadedModel = model;
    silenceHarmlessEmbedderWarnings();
    // Dynamic import keeps the (heavy) Transformers.js + onnxruntime cost out of
    // CLI startup; it is only paid when embeddings are actually needed. The
    // `pipeline` overloads produce a union too large for TS to represent, so we
    // narrow it to the single signature we use. `dtype: "fp32"` is passed
    // explicitly to avoid the "dtype not specified" warning.
    pipelinePromise = import("@huggingface/transformers").then(({ pipeline }) => {
      const make = pipeline as unknown as (
        task: "feature-extraction",
        model: string,
        options: { dtype: "fp32" }
      ) => Promise<FeatureExtractionPipeline>;
      return make("feature-extraction", model, { dtype: "fp32" });
    });
  }
  return pipelinePromise;
}

/**
 * Embed texts into normalized mean-pooled vectors. Always returns one vector per
 * input (same order). Throws if the model cannot be loaded (e.g. first-run
 * download with no network) — there is no fallback.
 */
export async function embedLocal(texts: string[]): Promise<{ vectors: number[][]; model: string }> {
  if (texts.length === 0) return { vectors: [], model: embedModelId() };
  const extractor = await getExtractor();
  const vectors: number[][] = [];
  const BATCH = 32;
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    const out = await extractor(batch, { pooling: "mean", normalize: true });
    const rows = out.tolist() as number[][];
    for (const row of rows) {
      if (!Array.isArray(row) || row.length === 0) {
        throw new Error(`Local embedder '${embedModelId()}' produced an empty vector.`);
      }
      vectors.push(row);
    }
  }
  return { vectors, model: embedModelId() };
}

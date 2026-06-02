// Curated catalog of Foundry Local models exposed in the TWC CLI.
// Users can also pass arbitrary model IDs via `--model` or `/model <id>`.
// To install a model on the machine: `foundry model run <id>`.

export interface ModelEntry {
  /** Foundry Local model id (the one used as the OpenAI `model` field). */
  id: string;
  /** Short human-friendly alias accepted by the CLI in place of the full id. */
  alias: string;
  /** Family / vendor tag for grouping. */
  family: string;
  /** Best accelerator for this build. */
  accelerator: "npu" | "gpu" | "cpu";
  /** One-line description for `models list`. */
  description: string;
}

export const MODEL_CATALOG: ReadonlyArray<ModelEntry> = [
  // --- Reasoning-focused (recommended) ---
  {
    id: "deepseek-r1-distill-qwen-7b-qnn-npu:2",
    alias: "deepseek-r1-7b",
    family: "DeepSeek",
    accelerator: "npu",
    description: "DeepSeek-R1 distilled into Qwen 7B, Snapdragon NPU build — strongest reasoning that still runs on the NPU. Default."
  },
  {
    id: "Phi-4-mini-reasoning-generic-cpu:3",
    alias: "phi4-mini-reasoning",
    family: "Microsoft Phi",
    accelerator: "cpu",
    description: "Phi-4 Mini Reasoning, CPU build — purpose-built for step-by-step reasoning (slower, CPU only)."
  },
  {
    id: "Phi-4-generic-cpu:2",
    alias: "phi4",
    family: "Microsoft Phi",
    accelerator: "cpu",
    description: "Phi-4 full, CPU build — highest-quality Phi reasoning, heavy (10 GB, CPU only)."
  },
  // --- Strong + tool-calling on NPU ---
  {
    id: "qwen2.5-7b-instruct-qnn-npu:2",
    alias: "qwen2.5-7b",
    family: "Alibaba Qwen",
    accelerator: "npu",
    description: "Qwen2.5 7B Instruct, Snapdragon NPU build — strong multilingual reasoning + native tool calling."
  },
  {
    id: "qwen2.5-1.5b-instruct-qnn-npu:2",
    alias: "qwen2.5-1.5b",
    family: "Alibaba Qwen",
    accelerator: "npu",
    description: "Qwen2.5 1.5B Instruct, NPU build — light + fast, supports tool calling."
  },
  // --- Phi small / fast (NPU) ---
  {
    id: "phi-3-mini-4k-instruct-qnn-npu:3",
    alias: "phi3-mini-npu",
    family: "Microsoft Phi",
    accelerator: "npu",
    description: "Phi-3 Mini 4K, Snapdragon NPU build — fastest, lightweight default for Copilot+ PCs."
  },
  {
    id: "phi-3.5-mini-instruct-qnn-npu:2",
    alias: "phi3.5-mini-npu",
    family: "Microsoft Phi",
    accelerator: "npu",
    description: "Phi-3.5 Mini Instruct, NPU build — small + fast, improved over Phi-3 Mini."
  },
  {
    id: "phi-3-mini-128k-instruct-qnn-npu:3",
    alias: "phi3-mini-128k-npu",
    family: "Microsoft Phi",
    accelerator: "npu",
    description: "Phi-3 Mini 128K, NPU build — long-context variant for large log bundles."
  }
];

/** Resolve an id-or-alias against the catalog; returns the canonical Foundry id. */
export function resolveModelId(input: string): string | undefined {
  const needle = input.trim();
  if (!needle) return undefined;
  const exact = MODEL_CATALOG.find((m) => m.id === needle);
  if (exact) return exact.id;
  const byAlias = MODEL_CATALOG.find((m) => m.alias.toLowerCase() === needle.toLowerCase());
  if (byAlias) return byAlias.id;
  // Allow free-form ids that look like Foundry Local model IDs (contain ":" or "-").
  if (/[:\-]/.test(needle)) return needle;
  return undefined;
}

export function findEntry(idOrAlias: string): ModelEntry | undefined {
  return MODEL_CATALOG.find((m) => m.id === idOrAlias || m.alias === idOrAlias);
}

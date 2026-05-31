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
  {
    id: "phi-3-mini-4k-instruct-qnn-npu:3",
    alias: "phi3-mini-npu",
    family: "Microsoft Phi",
    accelerator: "npu",
    description: "Phi-3 Mini 4K, Snapdragon NPU build — default for Copilot+ PCs."
  },
  {
    id: "phi-3.5-mini-instruct-generic-gpu:1",
    alias: "phi3.5-mini-gpu",
    family: "Microsoft Phi",
    accelerator: "gpu",
    description: "Phi-3.5 Mini Instruct, generic GPU build."
  },
  {
    id: "phi-4-mini-instruct-generic-gpu:1",
    alias: "phi4-mini-gpu",
    family: "Microsoft Phi",
    accelerator: "gpu",
    description: "Phi-4 Mini Instruct, generic GPU build — stronger reasoning."
  },
  {
    id: "phi-4-mini-instruct-generic-cpu:1",
    alias: "phi4-mini-cpu",
    family: "Microsoft Phi",
    accelerator: "cpu",
    description: "Phi-4 Mini Instruct, CPU fallback build."
  },
  {
    id: "qwen2.5-7b-instruct-generic-gpu:1",
    alias: "qwen2.5-7b-gpu",
    family: "Alibaba Qwen",
    accelerator: "gpu",
    description: "Qwen2.5 7B Instruct, generic GPU build — strong multilingual."
  },
  {
    id: "qwen2.5-0.5b-instruct-generic-cpu:1",
    alias: "qwen2.5-0.5b-cpu",
    family: "Alibaba Qwen",
    accelerator: "cpu",
    description: "Qwen2.5 0.5B Instruct, ultra-light CPU build."
  },
  {
    id: "mistralai-Mistral-7B-Instruct-v0-2-generic-gpu:1",
    alias: "mistral-7b-gpu",
    family: "Mistral AI",
    accelerator: "gpu",
    description: "Mistral 7B Instruct v0.2, generic GPU build."
  },
  {
    id: "deepseek-r1-distill-qwen-7b-generic-gpu:1",
    alias: "deepseek-r1-7b-gpu",
    family: "DeepSeek",
    accelerator: "gpu",
    description: "DeepSeek-R1 distilled into Qwen 7B — reasoning-focused."
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

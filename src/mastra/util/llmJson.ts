import { z } from "zod";

/**
 * Tolerant JSON extraction from LLM text output.
 * Handles code fences, leading/trailing prose, trailing commas.
 */
export function extractJson(raw: string): unknown {
  if (!raw) {
    throw new Error("Empty LLM output");
  }
  let text = raw.trim();
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]+?)```/i);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  }
  // Try first object/array
  const firstObj = text.indexOf("{");
  const firstArr = text.indexOf("[");
  const start = [firstObj, firstArr].filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? -1;
  if (start === -1) {
    throw new Error("No JSON object/array found in LLM output");
  }
  const candidate = text.slice(start);
  const lastObj = candidate.lastIndexOf("}");
  const lastArr = candidate.lastIndexOf("]");
  const end = Math.max(lastObj, lastArr);
  if (end === -1) {
    throw new Error("Unterminated JSON in LLM output");
  }
  const slice = candidate.slice(0, end + 1).replace(/,\s*([}\]])/g, "$1");
  try {
    return JSON.parse(slice);
  } catch (err) {
    throw new Error(`JSON parse failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export interface GenerateLike {
  generate(prompt: string): Promise<{ text?: string }>;
}

export interface ParseOptions<T> {
  schema: z.ZodType<T, z.ZodTypeDef, any>;
  retries?: number;
  /**
   * Optional safety net. When provided, it is returned if every LLM attempt
   * fails. When omitted (the default for agent calls) a persistent failure is
   * thrown: Foundry Local is mandatory and there is no heuristic fallback.
   */
  fallback?: T;
}

/**
 * Call an agent, parse strict-JSON output against a Zod schema and retry on
 * failure. If `fallback` is provided it is returned when all attempts fail;
 * otherwise the last error is thrown. Designed for small NPU/local models.
 */
export async function generateStructured<T>(
  agent: GenerateLike,
  prompt: string,
  options: ParseOptions<T>
): Promise<T> {
  const retries = options.retries ?? 1;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const result = await agent.generate(prompt);
      const data = extractJson(result.text ?? "");
      return options.schema.parse(data);
    } catch (err) {
      lastError = err;
      // Reinforce strictness on retry
      prompt = `${prompt}\n\nIMPORTANT: Reply ONLY with valid JSON matching the schema. No prose, no markdown.`;
    }
  }
  if (options.fallback !== undefined) {
    return options.fallback;
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("LLM structured generation failed and no fallback was provided");
}

export { z };

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { answerFromKnowledge } from "../../knowledge/teamviewerDocs.js";

const docsInputSchema = z.object({
  query: z.string().describe("The TeamViewer question to answer from official documentation")
});

const docsOutputSchema = z.object({
  answer: z.string(),
  confident: z.boolean(),
  citations: z.array(z.string())
});

/**
 * Lets an agent consult the TeamViewer knowledge layer: verified facts plus the
 * official documentation (fetched on demand). When the answer isn't grounded the
 * tool says so and returns the authoritative source URL instead of guessing.
 */
export const teamviewerDocsTool = createTool({
  id: "tw-official-docs",
  description:
    "Answer a TeamViewer question using verified facts and the official documentation. " +
    "Returns { answer, confident, citations }. " +
    "If confident is false, do not invent details — tell the user to check the cited official URL.",
  inputSchema: docsInputSchema,
  outputSchema: docsOutputSchema,
  execute: async (input: z.infer<typeof docsInputSchema>) => {
    const result = await answerFromKnowledge(input.query);
    return { answer: result.answer, confident: result.confident, citations: result.citations };
  }
});

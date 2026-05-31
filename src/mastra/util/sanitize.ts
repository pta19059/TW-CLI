/**
 * Sanitize free-form user text before embedding into LLM prompts.
 * Strips role markers, control characters, fences and clamps length.
 */
export function sanitizePromptInput(raw: string | undefined, maxLength = 4000): string {
  if (!raw) {
    return "";
  }
  let text = String(raw);
  // Strip null + non-printable controls except \n \r \t
  text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ");
  // Neutralize role markers that could break out of the prompt
  text = text.replace(/<\|(?:system|user|assistant|tool|im_start|im_end)\|>/gi, "");
  text = text.replace(/^\s*(?:system|assistant|user|tool)\s*:\s*/gim, "");
  // Neutralize fenced code blocks containing instructions
  text = text.replace(/```+/g, "'''");
  // Common prompt-injection trigger phrases get defanged
  text = text.replace(/ignore (?:all )?previous instructions/gi, "[redacted-instruction]");
  // Collapse excessive whitespace
  text = text.replace(/[\t ]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (text.length > maxLength) {
    text = text.slice(0, maxLength) + "…";
  }
  return text;
}

export const ILLUSTRATION_CREDIT = "AI-generated illustration";

/** Generated artwork must never inherit a caption describing a real photo. */
export function illustrationCaption(caption?: string | null): string {
  const trimmed = caption?.trim();
  if (trimmed && /^Illustration:\s*\S/i.test(trimmed)) {
    return `Illustration: ${trimmed.slice(trimmed.indexOf(":") + 1).trim()}`;
  }
  return "Illustration: the article's central mechanism";
}

import { type CommunityModerationResult } from "~/@/types/community";

const SUSPICIOUS_PATTERNS = [
  /\bjoin my discord\b/i,
  /\bjoin my telegram\b/i,
  /\bdm me\b/i,
  /\bbuy now\b/i,
  /\bguaranteed\b/i,
  /\bpump\b/i,
];

function normalizeCommunityText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function moderateCommunityText(text: string): CommunityModerationResult {
  const normalizedText = normalizeCommunityText(text);
  const reasons = SUSPICIOUS_PATTERNS.filter((pattern) =>
    pattern.test(normalizedText),
  ).map((pattern) => pattern.source);

  return {
    normalizedText,
    status: reasons.length > 0 ? "needs_review" : "active",
    reasons,
  };
}

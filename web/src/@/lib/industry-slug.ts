/** Canonical URL/catalog slug for a GICS industry name. */
export function createSlug(industry: string): string {
  return industry
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

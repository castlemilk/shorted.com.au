export function normalizeFirebasePublicConfigValue(value: string | undefined) {
  return value?.replace(/\\[nr]/g, "").trim();
}

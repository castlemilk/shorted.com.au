const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

export const CLOUDFLARE_JSD_SENSITIVE_PATH_PREFIXES = [
  "/signin",
  "/signup",
  "/dashboards",
  "/portfolio",
  "/alerts",
  "/chat",
  "/admin",
  "/developer",
  "/subscribe",
  "/unsubscribe",
  "/api/auth",
  "/api/stripe",
  "/api/community",
  "/chat.v1.ChatService",
] as const;

const CLOUDFLARE_JSD_SENSITIVE_PATH_PATTERNS = [
  /^\/shorts\/[^/]+\/community(?:\/|$)/,
] as const;

export function isCloudflareJsDetectionsManualEnabled(
  value = process.env.NEXT_PUBLIC_CLOUDFLARE_JSD_MANUAL_ENABLED,
): boolean {
  return TRUE_VALUES.has((value ?? "").trim().toLowerCase());
}

export function normalizePathname(pathname: string | null | undefined): string {
  const trimmedPathname = pathname?.trim();
  const rawPathname =
    trimmedPathname && trimmedPathname.length > 0 ? trimmedPathname : "/";
  const splitPath = rawPathname.split("?")[0]?.split("#")[0];
  const pathWithoutQuery = splitPath && splitPath.length > 0 ? splitPath : "/";
  const pathWithSlash = pathWithoutQuery.startsWith("/")
    ? pathWithoutQuery
    : `/${pathWithoutQuery}`;

  return pathWithSlash.length > 1
    ? pathWithSlash.replace(/\/+$/, "")
    : pathWithSlash;
}

export function isCloudflareJsDetectionPath(
  pathname: string | null | undefined,
): boolean {
  const path = normalizePathname(pathname);

  return (
    CLOUDFLARE_JSD_SENSITIVE_PATH_PREFIXES.some(
      (prefix) => path === prefix || path.startsWith(`${prefix}/`),
    ) ||
    CLOUDFLARE_JSD_SENSITIVE_PATH_PATTERNS.some((pattern) =>
      pattern.test(path),
    )
  );
}

const AUTH_CALLBACK_ORIGIN = "https://shorted.invalid";

/** Convert same-origin callbacks to local paths for client navigation. */
export function safeAuthCallbackUrl(
  value: string | null | undefined,
  origin: string | null | undefined = typeof window !== "undefined"
    ? window.location.origin
    : undefined,
): string {
  if (
    !value ||
    (!value.startsWith("/") && !/^https?:\/\//i.test(value)) ||
    value.startsWith("//") ||
    /[\\\u0000-\u0020\u007f]/.test(value)
  ) {
    return "/";
  }

  try {
    const baseOrigin = origin ? new URL(origin).origin : AUTH_CALLBACK_ORIGIN;
    const url = new URL(value, baseOrigin);
    if (
      (!value.startsWith("/") && !origin) ||
      url.origin !== baseOrigin ||
      (url.protocol !== "https:" && url.protocol !== "http:")
    ) {
      return "/";
    }
    const path = url.pathname.replace(/\/+$/, "");
    if (path === "/signin" || path === "/signup") return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}

export function authPageHref(
  page: "/signin" | "/signup",
  callbackUrl: string,
): string {
  const callback = safeAuthCallbackUrl(callbackUrl);
  return callback === "/"
    ? page
    : `${page}?${new URLSearchParams({ callbackUrl: callback }).toString()}`;
}

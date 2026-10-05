"use client";

import { useEffect, useState } from "react";
import { safeAuthCallbackUrl } from "@/lib/auth-redirect";

/** Callback-derived markup must match on the server and first client render. */
export function useAuthCallback(value: string | null) {
  const [origin, setOrigin] = useState<string | null>(null);
  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);
  return {
    callbackUrl: safeAuthCallbackUrl(value, origin),
    ready: origin !== null,
  };
}

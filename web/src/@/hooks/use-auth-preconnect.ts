"use client";

import { useEffect } from "react";

/**
 * Pre-establishes connections to the origins the Google sign-in popup needs
 * (the Firebase auth-helper domain and Google's OAuth endpoints) while the
 * visitor is still reading the form — the TLS handshakes overlap idle time
 * instead of the click. react-dom's preconnect() isn't exported by the React
 * canary Next 14 ships, so the hints are injected directly.
 */
export function useAuthPreconnect() {
  useEffect(() => {
    const authDomain = process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN?.trim();
    const origins = [
      authDomain ? `https://${authDomain}` : null,
      "https://accounts.google.com",
      "https://apis.google.com",
    ].filter((origin): origin is string => Boolean(origin));

    const links = origins.map((href) => {
      const link = document.createElement("link");
      link.rel = "preconnect";
      link.href = href;
      link.crossOrigin = "anonymous";
      document.head.appendChild(link);
      return link;
    });
    return () => {
      for (const link of links) link.remove();
    };
  }, []);
}

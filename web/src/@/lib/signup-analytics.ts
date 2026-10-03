import { sendGaEvent } from "./analytics-events";

export type SignupMethod = "email" | "google";

/** Only called for a new account after a usable Shorted session is confirmed. */
export function trackSignupComplete(method: SignupMethod): void {
  if (method !== "email" && method !== "google") return;
  // Fixed location and origin-only referrer: never send auth callback URLs,
  // names, emails, Firebase IDs, credentials or provider tokens.
  let referrerOrigin = "";
  try {
    referrerOrigin = new URL(document.referrer).origin;
  } catch {
    // Empty/unparseable referrers have no useful attribution.
  }
  sendGaEvent("sign_up", {
    method,
    surface: "/signup",
    page_location: "https://shorted.com.au/signup",
    page_referrer: referrerOrigin,
  });
}

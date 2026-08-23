/**
 * Best-effort operator notification email, via Resend.
 *
 * This is the Vercel-side twin of the Go notifier in
 * `services/shorts/internal/services/register/notify.go` and deliberately keeps
 * the same three properties, for the same reasons:
 *
 *   - **Dormant when unconfigured.** No RESEND_API_KEY → no-op. The feature can
 *     ship before the secret exists without erroring on every webhook.
 *   - **Never throws.** This is the load-bearing one here. The Stripe webhook
 *     returns 500 on an unhandled error, and Stripe RETRIES a 500 — so an email
 *     outage would replay subscription grants. A notification failing must never
 *     be able to affect payment processing.
 *   - **Short timeout, sent inline.** Stripe gives a webhook a limited budget
 *     (and treats a timeout as a failure worth retrying), so the send is capped
 *     well under it rather than left to a detached promise that the runtime may
 *     never finish.
 *
 * Server-only: it reads secrets from the environment and must never be imported
 * into a client component.
 */

const RESEND_ENDPOINT = "https://api.resend.com/emails";

/**
 * Matches what the Go notifier is actually DEPLOYED with (the `resend_to` /
 * `resend_from` Terraform defaults in modules/shorts-api/variables.tf), not the
 * fallbacks in its source.
 *
 * The From address matters: `shorted.com.au` is the Resend-verified sending
 * domain (resend._domainkey + send.shorted.com.au SPF in DNS). Sending from an
 * unverified address is rejected by Resend, and since this notifier swallows
 * failures by design, that would fail SILENTLY — no email, no error.
 */
const DEFAULT_FROM = "Shorted <support@shorted.com.au>";
const DEFAULT_TO = "support@shorted.com.au";

/** Capped well under Stripe's webhook budget — see the note above. */
const SEND_TIMEOUT_MS = 3_000;

export interface OperatorEmail {
  subject: string;
  /** Plain text only. These are operator alerts, not marketing. */
  text: string;
}

/**
 * Send an operator alert. Resolves to whether the email was actually sent, so
 * callers can assert in tests; production callers ignore it.
 *
 * Never rejects.
 */
export async function notifyOperator(
  email: OperatorEmail,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const apiKey = process.env.RESEND_API_KEY?.trim();
    if (!apiKey) return false; // not configured — dormant, not an error

    const from = process.env.RESEND_FROM?.trim() || DEFAULT_FROM;
    const to = process.env.RESEND_TO?.trim() || DEFAULT_TO;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);

    try {
      const res = await fetchImpl(RESEND_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from,
          // Resend accepts a comma-separated list; support multiple operators.
          to: to.split(",").map((addr) => addr.trim()).filter(Boolean),
          subject: email.subject,
          text: email.text,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        // Deliberately does not log the body: a Resend error response can echo
        // request content, and these emails carry customer addresses.
        console.warn(`notifyOperator: resend returned ${res.status}`);
        return false;
      }
      return true;
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    // Includes the abort on timeout. Swallowed on purpose — see the module doc.
    console.warn(
      `notifyOperator: send failed: ${err instanceof Error ? err.message : "unknown"}`,
    );
    return false;
  }
}

/** Format cents in a currency for an operator-facing line. e.g. "$20.00 AUD". */
export function formatAmount(
  amountInCents: number | null | undefined,
  currency: string | null | undefined,
): string {
  if (typeof amountInCents !== "number" || !Number.isFinite(amountInCents)) {
    return "unknown amount";
  }
  const code = (currency || "aud").toUpperCase();
  return `$${(amountInCents / 100).toFixed(2)} ${code}`;
}

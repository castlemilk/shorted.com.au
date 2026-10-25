/**
 * Transactional email to a customer, via Resend. Same provider, key and verified
 * From address as operator-notify.ts (the operator notifier is for operators only,
 * with a fixed recipient, so it is not reused here).
 *
 * Server-only. Never throws: resolves to whether Resend accepted the message.
 * Callers must not log `text`, because these messages can carry sign-in links.
 */

const RESEND_ENDPOINT = "https://api.resend.com/emails";

/** The Resend-verified sending domain. An unverified From is rejected by Resend. */
const DEFAULT_FROM = "Shorted <support@shorted.com.au>";

const SEND_TIMEOUT_MS = 5_000;

export interface CustomerEmail {
  to: string;
  subject: string;
  /** Plain text only. */
  text: string;
}

export async function sendResendEmail(
  email: CustomerEmail,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) return false; // not configured: the caller reports a failed send

  // Blank must fall back to the verified default: Resend rejects an empty From.
  const fromSetting = process.env.RESEND_FROM?.trim();
  const from = fromSetting ? fromSetting : DEFAULT_FROM;
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
        to: [email.to],
        subject: email.subject,
        text: email.text,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`sendResendEmail: resend returned ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(
      `sendResendEmail: send failed: ${err instanceof Error ? err.name : "unknown"}`,
    );
    return false;
  } finally {
    clearTimeout(timer);
  }
}

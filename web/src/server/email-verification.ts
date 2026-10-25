import { adminAuth } from "~/@/lib/firebase-admin";
import { siteConfig } from "~/@/config/site";
import { consumeRateLimit } from "~/@/lib/rate-limit";
import { sendResendEmail } from "~/@/lib/resend-email";

/**
 * Per-user limits on verification sends: one a minute, five a day. Each window has
 * its own bucket, so the minute counter cannot be reset by the day counter.
 */
export const VERIFICATION_SEND_WINDOWS = [
  {
    bucketName: "verify-email-minute",
    authenticatedLimit: 1,
    windowSeconds: 60,
  },
  {
    bucketName: "verify-email-day",
    authenticatedLimit: 5,
    windowSeconds: 24 * 60 * 60,
  },
] as const;

export type VerificationSendLimit =
  | { ok: true }
  | { ok: false; retryAfterSeconds: number };

/**
 * Takes one send from the user's budget. Checks every window and reports the
 * longest wait, so the user is told when to try again.
 */
export async function consumeVerificationSend(
  uid: string,
): Promise<VerificationSendLimit> {
  let retryAfterSeconds = 0;
  for (const window of VERIFICATION_SEND_WINDOWS) {
    const result = await consumeRateLimit(`verify-email:${uid}`, window);
    if (!result.success) {
      retryAfterSeconds = Math.max(retryAfterSeconds, result.retryAfterSeconds);
    }
  }
  return retryAfterSeconds > 0
    ? { ok: false, retryAfterSeconds }
    : { ok: true };
}

/**
 * Creates a Firebase email-verification link and mails it with Resend. Returns
 * whether the mail was accepted. The link is a credential, so it is never logged.
 */
export async function sendVerificationEmail(email: string): Promise<boolean> {
  let link: string;
  try {
    link = await adminAuth.generateEmailVerificationLink(email, {
      url: `${siteConfig.url}/alerts?verified=1`,
    });
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    console.warn(
      `[email-verification] link generation failed (${typeof code === "string" ? code : "unknown"})`,
    );
    return false;
  }

  return sendResendEmail({
    to: email,
    subject: "Verify your email for Shorted alerts",
    text: [
      "Confirm this email address so Shorted can send your short-position alerts here.",
      "",
      link,
      "",
      "If you did not ask for this, you can ignore this email. No alerts will be sent until the address is verified.",
    ].join("\n"),
  });
}

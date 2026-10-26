"use server";

import { auth } from "~/server/auth";
import { lookupAccountVerification } from "~/server/account-verification";
import {
  consumeVerificationSend,
  sendVerificationEmail,
} from "~/server/email-verification";

export type SendVerificationResult =
  | { ok: true; status: "sent" | "already-verified" }
  | { ok: false; error: string; retryAfterSeconds?: number };

const SIGN_IN = "Sign in to verify your email.";
const NO_ADDRESS = "There is no email address on this account to verify.";
const NOT_PASSWORD =
  "This account signs in another way, so there is no verification email to send.";
const SEND_FAILED = "Could not send the email. Try again shortly.";

/**
 * Sends the verification email for the signed-in account's address. Only the
 * caller's own account is read or affected, and the result says nothing about any
 * other account.
 */
export async function sendAlertVerificationEmail(): Promise<SendVerificationResult> {
  const session = await auth();
  const uid = session?.user?.id;
  if (!uid) return { ok: false, error: SIGN_IN };

  // The session may be stale, so the account is read from Firebase first.
  const account = await lookupAccountVerification(uid);
  if (!account) return { ok: false, error: NO_ADDRESS };
  if (account.verified) return { ok: true, status: "already-verified" };
  if (!account.hasPassword) return { ok: false, error: NOT_PASSWORD };

  const limit = await consumeVerificationSend(uid);
  if (!limit.ok) {
    return {
      ok: false,
      error: "You have asked for several emails. Try again shortly.",
      retryAfterSeconds: limit.retryAfterSeconds,
    };
  }

  const sent = await sendVerificationEmail(account.email);
  return sent
    ? { ok: true, status: "sent" }
    : { ok: false, error: SEND_FAILED };
}

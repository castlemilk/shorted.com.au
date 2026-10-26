/**
 * Customer-facing billing emails, sent from support@ through the same Resend path
 * as the operator alerts (see operator-notify.ts).
 *
 * Both are sent from the Stripe webhook, so both are idempotent by key: a webhook
 * retry, or a second delivery of the same event, sends one email. The keys are
 * named for the invoice, so the failed and the recovered notes never share one.
 *
 * Plain text only. An email body is never logged, because it carries the customer's
 * address and the links they can act on.
 */
import { formatAmount, sendResendEmail } from "~/@/lib/operator-notify";

export interface PaymentFailedEmail {
  to: string;
  invoiceId: string;
  amountCents: number | null | undefined;
  currency: string | null | undefined;
  /** Billing-portal link to update the card, or null when one could not be made. */
  updatePaymentUrl: string | null;
  /** Stripe's hosted invoice page, where the invoice can be paid directly. */
  invoiceUrl: string | null;
}

export interface PaymentRecoveredEmail {
  to: string;
  invoiceId: string;
}

export function paymentFailedKey(invoiceId: string): string {
  return `billing-payment-failed-${invoiceId}`;
}

export function paymentRecoveredKey(invoiceId: string): string {
  return `billing-payment-recovered-${invoiceId}`;
}

/** The first failed attempt on a subscription invoice. Access continues during retries. */
export async function sendPaymentFailedEmail(email: PaymentFailedEmail): Promise<boolean> {
  const amount = formatAmount(email.amountCents, email.currency);
  return sendResendEmail(
    {
      to: email.to,
      subject: "Your Shorted payment didn't go through",
      idempotencyKey: paymentFailedKey(email.invoiceId),
      text: [
        `We couldn't take your ${amount} payment for your Shorted subscription.`,
        "",
        "Your access continues. Stripe will retry the card over the next few days, and",
        "nothing changes while it does.",
        "",
        ...(email.updatePaymentUrl
          ? ["To update your card, use this link:", email.updatePaymentUrl, ""]
          : []),
        ...(email.invoiceUrl
          ? ["You can also pay this invoice directly:", email.invoiceUrl, ""]
          : []),
        "If the payment still fails after Stripe's retries, your access will end.",
        "Reply to this email if you need help.",
        "",
        "— Shorted",
      ].join("\n"),
    },
  );
}

/** A payment that went through only after an earlier attempt had failed. */
export async function sendPaymentRecoveredEmail(email: PaymentRecoveredEmail): Promise<boolean> {
  return sendResendEmail(
    {
      to: email.to,
      subject: "Payment received, thanks",
      idempotencyKey: paymentRecoveredKey(email.invoiceId),
      text: [
        "Your payment for your Shorted subscription went through.",
        "",
        "Your access is unchanged, and no action is needed.",
        "",
        "— Shorted",
      ].join("\n"),
    },
  );
}

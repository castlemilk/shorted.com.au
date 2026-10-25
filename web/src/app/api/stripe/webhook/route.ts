import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { headers } from "next/headers";
import type Stripe from "stripe";
import { stripe } from "~/lib/stripe";
import {
  idOf,
  resolveSubscriptionIdForInvoice,
  syncSubscriptionFromStripe,
} from "~/lib/billing-sync";
import { recordProductEvent } from "~/@/lib/product-events";
import { formatAmount, notifyOperator } from "~/@/lib/operator-notify";
import { sendPaymentFailedEmail, sendPaymentRecoveredEmail } from "~/@/lib/billing-email";

/**
 * Every subscription event is handled by re-reading the subscription from Stripe
 * (see lib/billing-sync.ts). Payloads are not applied, so out-of-order delivery
 * and retries cannot move a customer to the wrong state. Failures return 500 so
 * Stripe retries.
 */
export async function POST(request: NextRequest) {
  const started = Date.now();
  // Read per request, not at module load, so a rotated secret or a test's env
  // applies without a redeploy of the module graph.
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error("STRIPE_WEBHOOK_SECRET is not set");
    recordProductEvent({
      feature: "payment",
      action: "webhook_process",
      status: "error",
      properties: { error_type: "webhook_secret_missing" },
    });
    return NextResponse.json(
      { error: "Webhook secret not configured" },
      { status: 500 }
    );
  }

  const body = await request.text();
  const headersList = headers();
  const signature = headersList.get("stripe-signature");

  if (!signature) {
    recordProductEvent({
      feature: "payment",
      action: "webhook_process",
      status: "error",
      properties: { error_type: "missing_signature" },
    });
    return NextResponse.json(
      { error: "Missing stripe-signature header" },
      { status: 400 }
    );
  }

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`Webhook signature verification failed: ${message}`);
    recordProductEvent({
      feature: "payment",
      action: "webhook_process",
      status: "error",
      properties: { error_type: "signature_verification_failed" },
    });
    return NextResponse.json(
      { error: `Webhook Error: ${message}` },
      { status: 400 }
    );
  }

  try {
    recordProductEvent({
      feature: "payment",
      action: "webhook_process",
      status: "attempt",
      properties: { event_type: normalizeStripeEventType(event.type) },
    });

    switch (event.type) {
      case "checkout.session.completed": {
        await handleCheckoutCompleted(event.data.object);
        break;
      }

      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        await handleSubscriptionEvent(event.data.object);
        break;
      }

      case "invoice.payment_succeeded": {
        await handlePaymentSucceeded(event.data.object);
        break;
      }

      case "invoice.payment_failed": {
        await handlePaymentFailed(event.data.object);
        break;
      }

      // invoice.paid is the one that says an invoice is settled. A recovery note
      // needs it, because a retry that succeeded is also a payment_succeeded.
      case "invoice.paid": {
        await handleInvoicePaid(event.data.object);
        break;
      }

      case "charge.refunded": {
        await notifyChargeRefunded(event.data.object);
        break;
      }

      case "charge.dispute.created": {
        await notifyDisputeCreated(event.data.object);
        break;
      }

      // A card declined outside an invoice (notably during Checkout) produces
      // NO invoice.payment_failed, so without this a failed attempt to pay is
      // silent. Notify-only on purpose: a failed PaymentIntent must not mark
      // anything past_due — that is invoice.payment_failed's job, and doing it
      // here would downgrade a customer over a single declined attempt.
      case "payment_intent.payment_failed": {
        await notifyPaymentIntentFailed(event.data.object);
        break;
      }

      default:
        // Unhandled event type - ignore
    }

    recordProductEvent({
      feature: "payment",
      action: "webhook_process",
      status: "success",
      properties: {
        event_type: normalizeStripeEventType(event.type),
        duration_ms: Date.now() - started,
      },
    });

    return NextResponse.json({ received: true });
  } catch (error) {
    console.error("Error processing webhook:", error);
    recordProductEvent({
      feature: "payment",
      action: "webhook_process",
      status: "error",
      properties: {
        event_type: normalizeStripeEventType(event.type),
        duration_ms: Date.now() - started,
        error_name: error instanceof Error ? error.name : "Unknown",
      },
    });
    return NextResponse.json(
      { error: "Webhook handler failed" },
      { status: 500 }
    );
  }
}

/**
 * A payment attempt that failed without an invoice — typically a declined card
 * during Checkout. Notification only; it changes no subscription state.
 */
async function notifyPaymentIntentFailed(intent: Stripe.PaymentIntent) {
  const failure = intent.last_payment_error;
  const email =
    intent.receipt_email ?? failure?.payment_method?.billing_details?.email ?? null;

  await notifyOperator({
    subject: `Shorted payment attempt FAILED${email ? `: ${email}` : ""}`,
    text: [
      "Someone tried to pay and the payment was declined.",
      "",
      `Email:    ${email ?? "(unknown — no receipt email on the intent)"}`,
      `Amount:   ${formatAmount(intent.amount, intent.currency)}`,
      `Reason:   ${failure?.message ?? "(no reason given)"}`,
      `Code:     ${failure?.decline_code ?? failure?.code ?? "(none)"}`,
      `Customer: ${typeof intent.customer === "string" ? intent.customer : "(none)"}`,
      `Intent:   ${intent.id}`,
      "",
      "No subscription state was changed by this event.",
      "",
      "— shorted.com.au",
    ].join("\n"),
  });
}

function normalizeStripeEventType(type: string): string {
  return type.toLowerCase().replace(/[^a-z0-9_.:-]+/g, "_");
}

async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
  const subscriptionId = idOf(session.subscription);
  const customerId = idOf(session.customer);
  const userId = session.metadata?.userId ?? session.client_reference_id ?? undefined;
  const userEmail =
    session.metadata?.userEmail ??
    session.customer_email ??
    session.customer_details?.email ??
    undefined;

  // A paid session with no subscription (a Payment Link, or a one-off price)
  // gives this code nothing to grant. Tell the operator instead of guessing.
  if (session.mode !== "subscription" || !subscriptionId) {
    console.error(
      `Checkout session ${session.id} was paid without a subscription (mode=${session.mode})`,
    );
    await notifyOperator({
      subject: "Shorted payment with nothing to grant",
      text: [
        "A Checkout session was paid, but it created no subscription, so no access was granted.",
        "",
        `Email:    ${userEmail ?? "(unknown)"}`,
        `Amount:   ${formatAmount(session.amount_total, session.currency)}`,
        `Mode:     ${session.mode ?? "(none)"}`,
        `Customer: ${customerId ?? "(none)"}`,
        `Session:  ${session.id}`,
        "",
        "Check the Stripe dashboard. If this was meant to be a subscription, grant access by hand.",
        "",
        "— shorted.com.au",
      ].join("\n"),
    });
    return;
  }

  const result = await syncSubscriptionFromStripe(subscriptionId, {
    userId,
    userEmail,
  });

  // Operator alert. Deliberately AFTER the sync: the customer getting what
  // they paid for matters more than us hearing about it, and notifyOperator
  // never throws, so it cannot turn a completed grant into a retried webhook.
  await notifyOperator({
    subject: `New Shorted subscription: ${userEmail ?? "(no email on session)"}`,
    text: [
      "Someone just subscribed.",
      "",
      `Email:        ${userEmail ?? "(unknown)"}`,
      `Amount:       ${formatAmount(session.amount_total, session.currency)}`,
      `Customer:     ${customerId ?? "(none)"}`,
      `Subscription: ${subscriptionId}`,
      `Status:       ${result.status}`,
      `Linked:       ${result.ensuredRow ? "yes" : `no — status is ${result.status} or the subscription carried no Shorted user identity`}`,
      `Session:      ${session.id}`,
      "",
      "— shorted.com.au",
    ].join("\n"),
  });
}

async function handleSubscriptionEvent(subscription: Stripe.Subscription) {
  await syncSubscriptionFromStripe(subscription.id, {
    userId: subscription.metadata?.userId,
    userEmail: subscription.metadata?.userEmail,
  });
}

async function handlePaymentSucceeded(invoice: Stripe.Invoice) {
  const subscriptionId = await resolveSubscriptionIdForInvoice(invoice);
  if (!subscriptionId) {
    // A one-off invoice. There is no subscription state to change.
    console.warn(`Invoice ${invoice.id} has no subscription; nothing to sync`);
    return;
  }
  await syncSubscriptionFromStripe(subscriptionId);
}

async function handlePaymentFailed(invoice: Stripe.Invoice) {
  // Sync first, notify second. Stripe retries a failed delivery, and a 500 from
  // the sync means the retry runs this whole handler again. Notifying first
  // would email the operator once per retry.
  const subscriptionId = await resolveSubscriptionIdForInvoice(invoice);
  let subscriptionStatus: string | null = null;
  if (subscriptionId) {
    subscriptionStatus = (await syncSubscriptionFromStripe(subscriptionId)).status;
  }

  const customerId = idOf(invoice.customer) ?? "(none)";
  await notifyOperator({
    subject: `Shorted payment FAILED: ${invoice.customer_email ?? customerId}`,
    text: [
      "A subscription payment failed.",
      "",
      `Email:    ${invoice.customer_email ?? "(not on invoice)"}`,
      `Amount:   ${formatAmount(invoice.amount_due, invoice.currency)}`,
      `Customer: ${customerId}`,
      `Invoice:  ${invoice.id ?? "(none)"}`,
      invoice.hosted_invoice_url ? `Invoice URL: ${invoice.hosted_invoice_url}` : "",
      "",
      "Shorted now mirrors the status Stripe reports for the subscription, which is",
      "usually past_due while Stripe retries the payment.",
      "",
      "— shorted.com.au",
    ]
      .filter(Boolean)
      .join("\n"),
  });

  // The customer is told once, on the first failed attempt, and only while the
  // subscription is past_due: a failure on an incomplete first invoice is not a
  // lapse in access, so there is nothing to say that the email could keep true.
  // Later retries reuse the same Resend key, so a redelivery also sends nothing.
  if (subscriptionStatus === "past_due" && invoice.attempt_count === 1) {
    await emailCustomerPaymentFailed(invoice);
  }
}

async function emailCustomerPaymentFailed(invoice: Stripe.Invoice) {
  const to = invoice.customer_email;
  if (!to) {
    console.warn(`Invoice ${invoice.id} failed with no customer email; no payment-failed email sent`);
    return;
  }
  const customerId = idOf(invoice.customer);
  await sendPaymentFailedEmail({
    to,
    invoiceId: invoice.id ?? "unknown",
    amountCents: invoice.amount_due,
    currency: invoice.currency,
    updatePaymentUrl: customerId ? await createPortalLink(customerId) : null,
    invoiceUrl: invoice.hosted_invoice_url ?? null,
  });
}

/**
 * A fresh billing-portal link for the card update in the email. Null on any failure,
 * so the email still goes out with the invoice link.
 */
async function createPortalLink(customerId: string): Promise<string | null> {
  const baseUrl = process.env.NEXTAUTH_URL ?? "https://shorted.com.au";
  try {
    const portal = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${baseUrl}/pricing`,
    });
    return portal.url;
  } catch (error) {
    console.warn(`Billing portal link failed: ${error instanceof Error ? error.message : "unknown"}`);
    return null;
  }
}

/**
 * A payment that settled after an earlier attempt failed is a recovery. The first
 * attempt settling is not, so it sends nothing.
 */
async function handleInvoicePaid(invoice: Stripe.Invoice) {
  if (invoice.status !== "paid" || invoice.attempt_count <= 1) return;
  const to = invoice.customer_email;
  if (!to) return;
  await sendPaymentRecoveredEmail({ to, invoiceId: invoice.id ?? "unknown" });
}

/**
 * A refund needs a human decision about access, so it is an operator alert with
 * counts and ids only. Nothing about the subscription is changed here.
 */
async function notifyChargeRefunded(charge: Stripe.Charge) {
  const email = charge.billing_details?.email ?? charge.receipt_email ?? null;
  await notifyOperator({
    subject: `Shorted refund: ${formatAmount(charge.amount_refunded, charge.currency)}${email ? ` to ${email}` : ""}`,
    text: [
      "A charge was refunded in Stripe.",
      "",
      `Email:     ${email ?? "(unknown)"}`,
      `Refunded:  ${formatAmount(charge.amount_refunded, charge.currency)} of ${formatAmount(charge.amount, charge.currency)}`,
      `Customer:  ${idOf(charge.customer) ?? "(none)"}`,
      `Charge:    ${charge.id}`,
      "",
      "No subscription state was changed by this event. Check whether access should end.",
      "",
      "— shorted.com.au",
    ].join("\n"),
  });
}

/**
 * A dispute is a bank reversing a payment. It must be answered in the Stripe
 * dashboard before the evidence deadline, so it is an operator alert.
 */
async function notifyDisputeCreated(dispute: Stripe.Dispute) {
  const dueBy = dispute.evidence_details?.due_by;
  await notifyOperator({
    subject: `Shorted payment DISPUTED: ${formatAmount(dispute.amount, dispute.currency)}`,
    text: [
      "A customer has disputed a payment with their bank.",
      "Respond in the Stripe dashboard before the evidence deadline.",
      "",
      `Amount:        ${formatAmount(dispute.amount, dispute.currency)}`,
      `Reason:        ${dispute.reason ?? "(none)"}`,
      `Status:        ${dispute.status}`,
      `Evidence due:  ${dueBy ? new Date(dueBy * 1000).toISOString() : "(not set)"}`,
      `Charge:        ${idOf(dispute.charge) ?? "(unknown)"}`,
      `Dispute:       ${dispute.id}`,
      "",
      "No subscription state was changed by this event.",
      "",
      "— shorted.com.au",
    ].join("\n"),
  });
}

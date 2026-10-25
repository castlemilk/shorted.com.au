"use server";

import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";

import type { AlertEventView, AlertMonitorView } from "~/app/alerts/alert-model";
import {
  AlertMonitorCadence,
  AlertMonitorCondition,
  AlertMonitorScope,
  AlertMonitorStatus,
} from "~/gen/shorts/v1alpha1/alerts_pb";
import { AlertsService } from "~/gen/shorts/v1alpha1/alerts_pb";
import { auth } from "~/server/auth";
import { lookupAccountVerification } from "~/server/account-verification";
import { SHORTS_API_URL, serverFetchWithUserAgent } from "./config";
import {
  alertErrorMessage,
  eventToView,
  monitorToView,
  timestampToIso,
} from "./alert-mapping";

const INTERNAL_SECRET =
  process.env.INTERNAL_SERVICE_SECRET ?? "dev-internal-secret";

const SIGN_IN_TO_MANAGE = "Sign in to manage your alerts.";
const LIST_FAILED = "Could not load your alerts. Try again shortly.";
const UPDATE_FAILED = "Could not update the monitor. Try again shortly.";
const DELETE_FAILED = "Could not delete the monitor. Try again shortly.";
const CREATE_LIMIT_REACHED =
  "You already have the most active alerts allowed. Pause or delete one to add another.";

export type AlertMonitorScopeInput = "industry" | "stock";
export type AlertMonitorConditionInput =
  | "short-interest-above"
  | "short-interest-rises"
  | "new-top-ten-entry";
export type AlertMonitorCadenceInput = "Daily" | "Weekly";

export type CreateAlertMonitorInput = {
  scope: AlertMonitorScopeInput;
  target: string;
  condition: AlertMonitorConditionInput;
  threshold?: string;
  cadence: AlertMonitorCadenceInput;
};

export type CreateAlertMonitorResult =
  | {
      ok: true;
      monitor: {
        id: string;
        scope: AlertMonitorScopeInput;
        target: string;
        condition: AlertMonitorConditionInput;
        threshold: number | null;
        cadence: AlertMonitorCadenceInput;
        createdAt: string | null;
      };
    }
  | { ok: false; error: string };

export type ListAlertMonitorsResult =
  | {
      ok: true;
      monitors: AlertMonitorView[];
      /** YYYY-MM-DD of the latest report the evaluator checked; null before its first run. */
      checkedThroughReportDate: string | null;
    }
  | { ok: false; error: string };

export type ListAlertEventsResult =
  | { ok: true; events: AlertEventView[]; totalCount: number }
  | { ok: false; error: string };

export type UpdateAlertMonitorStatusResult =
  | { ok: true; monitor: AlertMonitorView }
  | { ok: false; error: string };

export type DeleteAlertMonitorResult = { ok: true } | { ok: false; error: string };

/**
 * The address the API may email alerts to. Only a verified address is sent: an
 * unverified sign-up keeps its monitors recorded but never emailed, because a
 * mistyped address would otherwise receive mail it never asked for.
 *
 * The session's flag is read once, at sign-in. An unverified session therefore asks
 * Firebase now, so a user who has clicked the link is not blocked until they sign
 * out. A failed lookup reads as unverified.
 */
async function deliverableEmail(
  session: {
    user?: { id?: string; email?: string | null; emailVerified?: boolean };
  } | null,
): Promise<string> {
  if (session?.user?.emailVerified === true) return session.user.email ?? "";
  const uid = session?.user?.id;
  if (!uid) return "";
  const account = await lookupAccountVerification(uid);
  return account?.verified ? account.email : "";
}

/**
 * The internal transport for one signed-in user. userEmail is "" unless the address
 * is verified (deliverableEmail), and x-user-email-verified says so explicitly: the
 * API stores and emails an address only when this header is "true". Other web
 * callers send x-user-email for their own reasons and never this header.
 */
function createAuthTransport(userId: string, userEmail: string) {
  return createConnectTransport({
    fetch: serverFetchWithUserAgent,
    baseUrl: SHORTS_API_URL,
    interceptors: [
      (next) => async (req) => {
        req.header.set("x-internal-secret", INTERNAL_SECRET);
        req.header.set("x-user-id", userId);
        req.header.set("x-user-email", userEmail);
        req.header.set(
          "x-user-email-verified",
          userEmail !== "" ? "true" : "false",
        );
        return await next(req);
      },
    ],
  });
}

export async function createAlertMonitor(
  input: CreateAlertMonitorInput,
): Promise<CreateAlertMonitorResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { ok: false, error: "Sign in to save alerts." };
  }

  const target = normalizeTarget(input.scope, input.target);
  if (!target) {
    return { ok: false, error: "Choose an industry or ASX code first." };
  }

  const usesThreshold = input.condition !== "new-top-ten-entry";
  const thresholdValue = Number.parseFloat(input.threshold ?? "");
  if (
    usesThreshold &&
    (!Number.isFinite(thresholdValue) ||
      thresholdValue <= 0 ||
      thresholdValue > 100)
  ) {
    return { ok: false, error: "Enter a threshold between 0 and 100." };
  }

  try {
    const transport = createAuthTransport(
      session.user.id,
      await deliverableEmail(session),
    );
    const client = createClient(AlertsService, transport);
    const response = await client.createAlertMonitor({
      scope:
        input.scope === "industry"
          ? AlertMonitorScope.INDUSTRY
          : AlertMonitorScope.STOCK,
      target,
      condition: mapCondition(input.condition),
      threshold: usesThreshold ? thresholdValue : 0,
      hasThreshold: usesThreshold,
      cadence:
        input.cadence === "Weekly"
          ? AlertMonitorCadence.WEEKLY
          : AlertMonitorCadence.DAILY,
    });

    if (!response.monitor) {
      return { ok: false, error: "The monitor was not saved." };
    }

    return {
      ok: true,
      monitor: {
        id: response.monitor.id,
        scope: input.scope,
        target: response.monitor.target || target,
        condition: input.condition,
        threshold: response.monitor.hasThreshold
          ? response.monitor.threshold
          : null,
        cadence: input.cadence,
        createdAt: timestampToIso(response.monitor.createdAt),
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: mapCreateMonitorError(error),
    };
  }
}

/** The signed-in user's monitors, with the last trigger for each. */
export async function listAlertMonitors(): Promise<ListAlertMonitorsResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { ok: false, error: SIGN_IN_TO_MANAGE };
  }

  try {
    const client = createClient(
      AlertsService,
      createAuthTransport(session.user.id, await deliverableEmail(session)),
    );
    const response = await client.listAlertMonitors({ limit: 50, offset: 0 });
    return {
      ok: true,
      monitors: response.monitors.map(monitorToView),
      checkedThroughReportDate: response.checkedThroughReportDate || null,
    };
  } catch (error) {
    return { ok: false, error: alertErrorMessage(error, LIST_FAILED) };
  }
}

/** Recent alert events for the signed-in user, newest report first. */
export async function listAlertEvents(
  input: { limit?: number; monitorId?: string } = {},
): Promise<ListAlertEventsResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { ok: false, error: SIGN_IN_TO_MANAGE };
  }

  const requested =
    typeof input.limit === "number" && Number.isFinite(input.limit)
      ? Math.trunc(input.limit)
      : 20;
  const limit = Math.min(Math.max(requested, 1), 100);

  try {
    const client = createClient(
      AlertsService,
      createAuthTransport(session.user.id, await deliverableEmail(session)),
    );
    const response = await client.listAlertEvents({
      limit,
      offset: 0,
      monitorId: input.monitorId ?? "",
    });
    return {
      ok: true,
      events: response.events.map(eventToView),
      totalCount: response.totalCount,
    };
  } catch (error) {
    return {
      ok: false,
      error: alertErrorMessage(error, "Could not load recent alerts. Try again shortly."),
    };
  }
}

/**
 * Pause or resume one of the signed-in user's monitors. Pausing never needs
 * Premium; resuming does, and the server answers PermissionDenied without it.
 */
export async function setAlertMonitorStatus(
  id: string,
  status: "active" | "paused",
): Promise<UpdateAlertMonitorStatusResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { ok: false, error: SIGN_IN_TO_MANAGE };
  }

  try {
    const client = createClient(
      AlertsService,
      createAuthTransport(session.user.id, await deliverableEmail(session)),
    );
    const response = await client.updateAlertMonitorStatus({
      id: id.trim(),
      status:
        status === "paused"
          ? AlertMonitorStatus.PAUSED
          : AlertMonitorStatus.ACTIVE,
    });
    if (!response.monitor) {
      return { ok: false, error: UPDATE_FAILED };
    }
    return { ok: true, monitor: monitorToView(response.monitor) };
  } catch (error) {
    return { ok: false, error: alertErrorMessage(error, UPDATE_FAILED) };
  }
}

/** Delete one of the signed-in user's monitors and its event history. */
export async function deleteAlertMonitor(
  id: string,
): Promise<DeleteAlertMonitorResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { ok: false, error: SIGN_IN_TO_MANAGE };
  }

  try {
    const client = createClient(
      AlertsService,
      createAuthTransport(session.user.id, await deliverableEmail(session)),
    );
    await client.deleteAlertMonitor({ id: id.trim() });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: alertErrorMessage(error, DELETE_FAILED) };
  }
}

function normalizeTarget(
  scope: AlertMonitorScopeInput,
  target: string,
): string {
  const normalized = target.trim().replace(/\s+/g, " ");
  return scope === "stock" ? normalized.toUpperCase() : normalized;
}

function mapCondition(
  condition: AlertMonitorConditionInput,
): AlertMonitorCondition {
  switch (condition) {
    case "short-interest-above":
      return AlertMonitorCondition.SHORT_INTEREST_ABOVE;
    case "short-interest-rises":
      return AlertMonitorCondition.SHORT_INTEREST_RISES;
    case "new-top-ten-entry":
      return AlertMonitorCondition.NEW_TOP_TEN_ENTRY;
  }
}

function mapCreateMonitorError(error: unknown): string {
  if (error instanceof ConnectError) {
    if (error.code === Code.PermissionDenied) {
      return "Upgrade to Premium to save alerts.";
    }
    if (error.code === Code.AlreadyExists) {
      return "That monitor is already active.";
    }
    if (error.code === Code.Unauthenticated) {
      return "Sign in to save alerts.";
    }
    if (error.code === Code.InvalidArgument) {
      return error.rawMessage || "Check the alert settings and try again.";
    }
    if (error.code === Code.ResourceExhausted) {
      return CREATE_LIMIT_REACHED;
    }
  }

  return "Could not save the monitor. Try again shortly.";
}

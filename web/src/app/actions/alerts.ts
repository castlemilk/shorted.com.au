"use server";

import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";

import {
  AlertMonitorCadence,
  AlertMonitorCondition,
  AlertMonitorScope,
  ShortedStocksService,
} from "~/gen/shorts/v1alpha1/shorts_pb";
import { auth } from "~/server/auth";
import { SHORTS_API_URL, serverFetchWithUserAgent } from "./config";

const INTERNAL_SECRET =
  process.env.INTERNAL_SERVICE_SECRET ?? "dev-internal-secret";

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

function createAuthTransport(userId: string, userEmail: string) {
  return createConnectTransport({
    fetch: serverFetchWithUserAgent,
    baseUrl: SHORTS_API_URL,
    interceptors: [
      (next) => async (req) => {
        req.header.set("x-internal-secret", INTERNAL_SECRET);
        req.header.set("x-user-id", userId);
        req.header.set("x-user-email", userEmail);
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
      session.user.email ?? "",
    );
    const client = createClient(ShortedStocksService, transport);
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

function timestampToIso(
  timestamp: { seconds: bigint | number | string; nanos?: number } | undefined,
): string | null {
  if (!timestamp) return null;
  const seconds = Number(timestamp.seconds);
  if (!Number.isFinite(seconds)) return null;
  return new Date(
    seconds * 1000 + Math.floor((timestamp.nanos ?? 0) / 1_000_000),
  ).toISOString();
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
      return error.message || "Check the alert settings and try again.";
    }
  }

  return "Could not save the monitor. Try again shortly.";
}

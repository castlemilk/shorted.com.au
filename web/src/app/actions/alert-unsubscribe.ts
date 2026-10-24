"use server";

// Pauses the alert monitor named by a signed alert-email token. No session: the
// token is the credential, and the public RPC can only pause, never resume or
// delete, so a leaked link pauses one alert at worst. Mirrors
// actions/unsubscribe.ts, the newsletter flow.

import {
  Code,
  ConnectError,
  createClient,
  type Interceptor,
} from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";

import type {
  AlertCadence,
  AlertCondition,
  AlertScope,
} from "~/app/alerts/alert-model";
import { AlertsService } from "~/gen/shorts/v1alpha1/alerts_pb";
import { SHORTS_API_URL, serverFetchWithUserAgent } from "./config";
import {
  cadenceFromProto,
  conditionFromProto,
  scopeFromProto,
} from "./alert-mapping";

export type PauseAlertByTokenResult =
  | {
      ok: true;
      /** True when the monitor was already paused, so nothing changed. */
      alreadyPaused: boolean;
      monitor: {
        scope: AlertScope;
        target: string;
        condition: AlertCondition;
        threshold: number | null;
        cadence: AlertCadence;
      };
    }
  /**
   * "invalid": the token does not verify. "gone": it verifies, but the monitor was
   * deleted, so there is nothing left to pause. "unavailable": the service failed.
   */
  | { ok: false; reason: "invalid" | "gone" | "unavailable" };

const browserUA: Interceptor = (next) => (req) => {
  req.header.set(
    "User-Agent",
    "Mozilla/5.0 (compatible; ShortedUnsubscribe/1.0)",
  );
  return next(req);
};

export async function pauseAlertByToken(
  token: string,
): Promise<PauseAlertByTokenResult> {
  const trimmed = typeof token === "string" ? token.trim() : "";
  if (!trimmed) {
    return { ok: false, reason: "invalid" };
  }

  try {
    const transport = createConnectTransport({
      fetch: serverFetchWithUserAgent,
      baseUrl: SHORTS_API_URL,
      interceptors: [browserUA],
    });
    const client = createClient(AlertsService, transport);
    const response = await client.pauseAlertMonitorByToken({ token: trimmed });
    return {
      ok: true,
      alreadyPaused: response.alreadyPaused,
      monitor: {
        scope: scopeFromProto(response.scope),
        target: response.target,
        condition: conditionFromProto(response.condition),
        threshold: response.hasThreshold ? response.threshold : null,
        cadence: cadenceFromProto(response.cadence),
      },
    };
  } catch (error) {
    if (error instanceof ConnectError && error.code === Code.InvalidArgument) {
      return { ok: false, reason: "invalid" };
    }
    if (error instanceof ConnectError && error.code === Code.NotFound) {
      return { ok: false, reason: "gone" };
    }
    return { ok: false, reason: "unavailable" };
  }
}

// Protobuf -> plain view mapping for the alert server actions. Not a "use
// server" module: it exports synchronous helpers, which a server-action file
// may not export. Only server modules import it, so the generated enums never
// reach a client bundle.

import { Code, ConnectError } from "@connectrpc/connect";

import type {
  AlertEvent,
  AlertEventCompany,
  AlertMonitor,
} from "~/gen/shorts/v1alpha1/alerts_pb";
import {
  AlertDeliveryStatus,
  AlertMonitorCadence,
  AlertMonitorCondition,
  AlertMonitorScope,
  AlertMonitorStatus,
} from "~/gen/shorts/v1alpha1/alerts_pb";
import type {
  AlertCadence,
  AlertCondition,
  AlertDeliveryState,
  AlertEventCompanyView,
  AlertEventView,
  AlertMonitorView,
  AlertScope,
  AlertStatus,
} from "~/app/alerts/alert-model";

export function scopeFromProto(scope: AlertMonitorScope): AlertScope {
  return scope === AlertMonitorScope.INDUSTRY ? "industry" : "stock";
}

export function conditionFromProto(
  condition: AlertMonitorCondition,
): AlertCondition {
  switch (condition) {
    case AlertMonitorCondition.SHORT_INTEREST_RISES:
      return "short-interest-rises";
    case AlertMonitorCondition.NEW_TOP_TEN_ENTRY:
      return "new-top-ten-entry";
    default:
      return "short-interest-above";
  }
}

export function cadenceFromProto(cadence: AlertMonitorCadence): AlertCadence {
  return cadence === AlertMonitorCadence.WEEKLY ? "Weekly" : "Daily";
}

export function statusFromProto(status: AlertMonitorStatus): AlertStatus {
  return status === AlertMonitorStatus.PAUSED ? "paused" : "active";
}

export function deliveryFromProto(
  status: AlertDeliveryStatus,
): AlertDeliveryState | null {
  switch (status) {
    case AlertDeliveryStatus.PENDING:
      return "pending";
    case AlertDeliveryStatus.SENT:
      return "sent";
    case AlertDeliveryStatus.FAILED:
      return "failed";
    case AlertDeliveryStatus.SKIPPED_UNENTITLED:
      return "skipped-unentitled";
    case AlertDeliveryStatus.SKIPPED_NO_EMAIL:
      return "skipped-no-email";
    case AlertDeliveryStatus.SKIPPED_PAUSED:
      return "skipped-paused";
    default:
      return null;
  }
}

export function timestampToIso(
  timestamp: { seconds: bigint | number | string; nanos?: number } | undefined,
): string | null {
  if (!timestamp) return null;
  const seconds = Number(timestamp.seconds);
  if (!Number.isFinite(seconds)) return null;
  return new Date(
    seconds * 1000 + Math.floor((timestamp.nanos ?? 0) / 1_000_000),
  ).toISOString();
}

export function monitorToView(monitor: AlertMonitor): AlertMonitorView {
  return {
    id: monitor.id,
    scope: scopeFromProto(monitor.scope),
    target: monitor.target,
    condition: conditionFromProto(monitor.condition),
    threshold: monitor.hasThreshold ? monitor.threshold : null,
    cadence: cadenceFromProto(monitor.cadence),
    status: statusFromProto(monitor.status),
    createdAt: timestampToIso(monitor.createdAt),
    lastEventReportDate: monitor.lastEventReportDate || null,
    lastDeliveryState: deliveryFromProto(monitor.lastDeliveryStatus),
    lastEventAt: timestampToIso(monitor.lastEventAt),
  };
}

function companyToView(company: AlertEventCompany): AlertEventCompanyView {
  return {
    productCode: company.productCode,
    companyName: company.companyName,
    latestPercent: company.latestPercent,
    previousPercent: company.hasPrevious ? company.previousPercent : null,
    changePoints: company.hasChange ? company.changePoints : null,
    rank: company.rank,
    previousRank: company.previousRank,
  };
}

export function eventToView(event: AlertEvent): AlertEventView {
  return {
    id: event.id,
    monitorId: event.monitorId,
    scope: scopeFromProto(event.scope),
    target: event.target,
    condition: conditionFromProto(event.condition),
    threshold: event.hasThreshold ? event.threshold : null,
    cadence: cadenceFromProto(event.cadence),
    reportDate: event.reportDate,
    comparedToDate: event.comparedToDate,
    companies: event.companies.map(companyToView),
    companiesTotal: event.companiesTotal,
    deliveryState: deliveryFromProto(event.deliveryStatus),
    sentAt: timestampToIso(event.sentAt),
    createdAt: timestampToIso(event.createdAt),
  };
}

/**
 * The message for a failed monitor-management call. Only the codes the
 * management RPCs can return are named; anything else gets the caller's
 * fallback. Never echoes the server message, which can carry internal detail.
 */
export function alertErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ConnectError) {
    switch (error.code) {
      case Code.NotFound:
        return "That monitor no longer exists.";
      case Code.AlreadyExists:
        return "An identical monitor is already active.";
      case Code.PermissionDenied:
        return "Upgrade to Premium to resume alerts.";
      case Code.Unauthenticated:
        return "Sign in to manage your alerts.";
      case Code.ResourceExhausted:
        return "You already have the most active alerts allowed. Pause or delete one before resuming this one.";
    }
  }
  return fallback;
}

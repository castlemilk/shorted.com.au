"use client";

import { useQuery } from "@tanstack/react-query";
import { useSession } from "next-auth/react";

import { Badge } from "~/@/components/ui/badge";
import { listAlertEvents } from "~/app/actions/alerts";
import {
  ALERT_EVENTS_QUERY_KEY,
  buildMonitorSummary,
  deliveryCopy,
  formatReportDate,
  movementCopy,
  rankCopy,
  type AlertEventView,
} from "./alert-model";

const EVENTS_LIMIT = 20;

/**
 * The last alerts that fired, newest report first. Each event is one monitor on
 * one report date, with the companies it fired on and what happened to its email.
 */
export function AlertEventsList() {
  const { data: session, status } = useSession();
  const signedIn = status === "authenticated" && !!session?.user;

  const query = useQuery({
    queryKey: [...ALERT_EVENTS_QUERY_KEY, EVENTS_LIMIT],
    queryFn: () => listAlertEvents({ limit: EVENTS_LIMIT }),
    enabled: signedIn,
  });

  if (status === "loading") {
    return (
      <div
        className="h-24 animate-pulse rounded-md bg-muted/60"
        aria-hidden="true"
      />
    );
  }

  if (!signedIn) {
    return (
      <p className="rounded-md border border-border/60 bg-background/60 p-4 text-sm text-muted-foreground">
        Sign in to see the alerts that have fired on your monitors.
      </p>
    );
  }

  if (query.isPending) {
    return (
      <div
        className="h-24 animate-pulse rounded-md bg-muted/60"
        aria-hidden="true"
      />
    );
  }

  const result = query.data;
  if (!result || !result.ok) {
    return (
      <div
        className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        role="alert"
      >
        {result?.error ?? "Could not load recent alerts. Try again shortly."}
      </div>
    );
  }

  if (result.events.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-border/60 bg-background/60 p-4 text-sm leading-6 text-muted-foreground">
        Nothing has fired yet. Each new ASIC report is checked against your
        monitors, and any that fire are listed here.
      </p>
    );
  }

  return (
    <ol className="space-y-3">
      {result.events.map((event) => (
        <EventCard key={event.id} event={event} />
      ))}
    </ol>
  );
}

function EventCard({ event }: { event: AlertEventView }) {
  const hidden = event.companiesTotal - event.companies.length;

  return (
    <li className="rounded-md border border-border/60 bg-background/60 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-medium">
            {formatReportDate(event.reportDate)} report
          </div>
          <div className="text-xs text-muted-foreground">
            compared with {formatReportDate(event.comparedToDate)}
          </div>
        </div>
        <Badge variant="outline" className="text-muted-foreground">
          {deliveryCopy(event.deliveryState)}
        </Badge>
      </div>

      <div className="mt-2 break-words text-sm">
        {buildMonitorSummary(event)}
      </div>

      <ul className="mt-3 space-y-1.5 text-sm">
        {event.companies.map((company) => {
          const rank = rankCopy(company);
          return (
            <li
              key={company.productCode}
              className="flex flex-wrap items-baseline gap-x-2"
            >
              <span className="font-mono font-medium">
                {company.productCode}
              </span>
              {company.companyName ? (
                <span className="text-muted-foreground">
                  {company.companyName}
                </span>
              ) : null}
              <span className="tabular-nums">{movementCopy(company)}</span>
              {rank ? (
                <span className="text-xs text-muted-foreground">{rank}</span>
              ) : null}
            </li>
          );
        })}
      </ul>

      {hidden > 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">
          and {hidden} more {hidden === 1 ? "company" : "companies"}
        </p>
      ) : null}
    </li>
  );
}

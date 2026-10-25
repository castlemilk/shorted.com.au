"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "next-auth/react";

import { EmailVerificationPrompt } from "~/@/components/email-verification-prompt";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "~/@/components/ui/alert-dialog";
import { Badge } from "~/@/components/ui/badge";
import { Button } from "~/@/components/ui/button";
import {
  deleteAlertMonitor,
  listAlertMonitors,
  setAlertMonitorStatus,
} from "~/app/actions/alerts";
import {
  ALERT_EVENTS_QUERY_KEY,
  ALERT_MONITORS_QUERY_KEY,
  buildMonitorSummary,
  formatReportDate,
  lastTriggeredCopy,
  type AlertMonitorView,
} from "./alert-model";

const ACTION_FAILED = "Could not update the monitor. Try again shortly.";
const DELETE_FAILED = "Could not delete the monitor. Try again shortly.";

/** Where the email goes and when it is checked. Shown above the monitor list. */
export function AlertDeliveryNote() {
  const { data: session } = useSession();
  const email = session?.user?.email;
  const verified = session?.user?.emailVerified === true;

  return (
    <div className="space-y-3">
      <p className="text-sm leading-6 text-muted-foreground">
        {email && !verified ? (
          <>
            Verify <span className="font-medium text-foreground">{email}</span>{" "}
            to receive alert emails. Until it is verified, alerts are recorded
            here but not emailed.
          </>
        ) : email ? (
          <>
            Alerts are emailed to{" "}
            <span className="font-medium text-foreground">{email}</span>.
          </>
        ) : (
          <>Alerts are emailed to the address on your account.</>
        )}{" "}
        We check hourly on business days and send once per new ASIC report (ASIC
        publishes around 11:30am Sydney time, covering positions held four
        trading days earlier). Alerts need an active Premium subscription; while
        it is inactive, alerts are recorded here but not emailed.
      </p>
      {email && !verified ? <EmailVerificationPrompt /> : null}
    </div>
  );
}

/**
 * The signed-in user's monitors: what each one is, whether it is active, when it
 * last fired and what happened to that email. Pause, resume and delete live here
 * too, and they are open to every signed-in account (resuming still needs
 * Premium, and the server says so).
 */
export function AlertMonitorList() {
  const { data: session, status } = useSession();
  const signedIn = status === "authenticated" && !!session?.user;
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ALERT_MONITORS_QUERY_KEY,
    queryFn: () => listAlertMonitors(),
    enabled: signedIn,
  });

  function refreshAfterChange() {
    void queryClient.invalidateQueries({ queryKey: ALERT_MONITORS_QUERY_KEY });
    void queryClient.invalidateQueries({ queryKey: ALERT_EVENTS_QUERY_KEY });
  }

  const statusMutation = useMutation({
    mutationFn: ({ id, next }: { id: string; next: "active" | "paused" }) =>
      setAlertMonitorStatus(id, next),
    onSuccess: (result) => {
      setActionError(result.ok ? null : result.error);
    },
    onError: () => setActionError(ACTION_FAILED),
    onSettled: refreshAfterChange,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteAlertMonitor(id),
    onSuccess: (result) => {
      setActionError(result.ok ? null : result.error);
    },
    onError: () => setActionError(DELETE_FAILED),
    onSettled: refreshAfterChange,
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
      <div className="rounded-md border border-border/60 bg-background/60 p-4 text-sm leading-6 text-muted-foreground">
        <Link
          href="/signin?callbackUrl=%2Falerts"
          className="font-medium text-primary hover:underline"
        >
          Sign in
        </Link>{" "}
        to see the alerts on your account.
      </div>
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
        {result?.error ?? "Could not load your alerts. Try again shortly."}
      </div>
    );
  }

  const busyId = statusMutation.isPending
    ? statusMutation.variables?.id
    : deleteMutation.isPending
      ? deleteMutation.variables
      : undefined;

  return (
    <div className="space-y-4">
      <AlertDeliveryNote />

      <p className="text-xs text-muted-foreground">
        {result.checkedThroughReportDate
          ? `Latest ASIC report checked: ${formatReportDate(result.checkedThroughReportDate)}`
          : "No ASIC report has been checked yet. The first check runs after the next report."}
      </p>

      {actionError ? (
        <div
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          role="alert"
        >
          {actionError}
        </div>
      ) : null}

      {result.monitors.length === 0 ? (
        <div className="rounded-md border border-dashed border-border/60 bg-background/60 p-4 text-sm text-muted-foreground">
          No monitors yet. Save one with the builder above.
        </div>
      ) : (
        <ul className="divide-y divide-border/60 rounded-md border border-border/60 bg-background/60">
          {result.monitors.map((monitor) => (
            <MonitorRow
              key={monitor.id}
              monitor={monitor}
              busy={busyId === monitor.id}
              onToggle={() =>
                statusMutation.mutate({
                  id: monitor.id,
                  next: monitor.status === "active" ? "paused" : "active",
                })
              }
              onDelete={() => deleteMutation.mutate(monitor.id)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function MonitorRow({
  monitor,
  busy,
  onToggle,
  onDelete,
}: {
  monitor: AlertMonitorView;
  busy: boolean;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const active = monitor.status === "active";
  const summary = buildMonitorSummary(monitor);

  return (
    <li className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="break-words text-sm font-medium">{summary}</span>
          <Badge
            variant="outline"
            className={
              active
                ? "border-primary/25 bg-primary/10 text-primary"
                : "text-muted-foreground"
            }
          >
            {active ? "Active" : "Paused"}
          </Badge>
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          {lastTriggeredCopy(monitor)}
        </div>
      </div>

      <div className="flex shrink-0 gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={onToggle}
          aria-label={`${active ? "Pause" : "Resume"} ${summary}`}
        >
          {busy ? "Saving…" : active ? "Pause" : "Resume"}
        </Button>
        <DeleteMonitorButton
          summary={summary}
          disabled={busy}
          onConfirm={onDelete}
        />
      </div>
    </li>
  );
}

function DeleteMonitorButton({
  summary,
  disabled,
  onConfirm,
}: {
  summary: string;
  disabled: boolean;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          aria-label={`Delete ${summary}`}
        >
          Delete
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this alert?</AlertDialogTitle>
          <AlertDialogDescription>
            {summary} will be removed along with its alert history. This cannot
            be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep alert</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>
            Delete alert
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

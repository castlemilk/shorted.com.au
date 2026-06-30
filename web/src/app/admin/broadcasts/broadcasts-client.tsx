"use client";

import { useState } from "react";
import { sendBroadcast } from "~/app/actions/sendBroadcast";
import type { Broadcast } from "~/app/actions/getBroadcasts";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CheckCircle2, XCircle, Clock, Send, Loader2, Mail } from "lucide-react";

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case "sent":
      return (
        <Badge
          variant="secondary"
          className="gap-1 bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400"
        >
          <CheckCircle2 className="h-3 w-3" />
          sent
        </Badge>
      );
    case "failed":
      return (
        <Badge variant="destructive" className="gap-1">
          <XCircle className="h-3 w-3" />
          failed
        </Badge>
      );
    case "draft":
      return (
        <Badge variant="outline" className="gap-1 text-muted-foreground">
          <Clock className="h-3 w-3" />
          draft
        </Badge>
      );
    default:
      return (
        <Badge variant="outline" className="gap-1 text-muted-foreground">
          {status}
        </Badge>
      );
  }
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function BroadcastsClient({ initial }: { initial: Broadcast[] }) {
  const [broadcasts, setBroadcasts] = useState<Broadcast[]>(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  async function onSend(b: Broadcast) {
    if (!confirm(`Send "${b.subject}" to all active subscribers?`)) return;
    setBusy(b.id);
    setMsg(null);
    const res = await sendBroadcast(b.id);
    setBusy(null);
    if (res.ok) {
      setMsg({ text: `Sent: ${b.subject}`, ok: true });
      // Optimistically mark as sent so the button disappears
      setBroadcasts((prev) =>
        prev.map((item) =>
          item.id === b.id ? { ...item, status: "sent", sentAt: new Date().toISOString() } : item,
        ),
      );
    } else {
      setMsg({ text: `Failed: ${res.error ?? "unknown error"}`, ok: false });
    }
  }

  if (broadcasts.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center text-muted-foreground">
        <Mail className="h-10 w-10 text-muted-foreground/30" />
        <span>No broadcasts yet.</span>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {msg && (
        <div
          className={`rounded-md border px-4 py-2.5 text-sm ${
            msg.ok
              ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-400"
              : "border-red-200 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950/30 dark:text-red-400"
          }`}
        >
          {msg.text}
        </div>
      )}

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[90px]">Status</TableHead>
            <TableHead className="w-[110px]">Type</TableHead>
            <TableHead>Subject</TableHead>
            <TableHead className="w-[80px] text-right">Recipients</TableHead>
            <TableHead className="w-[160px]">Created</TableHead>
            <TableHead className="w-[160px]">Sent</TableHead>
            <TableHead className="w-[90px]">Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {broadcasts.map((b) => {
            const canSend = b.status === "draft" || b.status === "failed";
            const isBusy = busy === b.id;
            return (
              <TableRow
                key={b.id}
                className={
                  b.status === "failed"
                    ? "bg-red-50/50 dark:bg-red-950/10"
                    : ""
                }
              >
                <TableCell>
                  <StatusBadge status={b.status} />
                </TableCell>
                <TableCell>
                  <span className="font-mono text-xs text-muted-foreground">{b.type}</span>
                </TableCell>
                <TableCell>
                  <div className="flex flex-col gap-0.5">
                    <span className="font-medium leading-snug">{b.subject}</span>
                    {b.sourceRef && (
                      <span className="text-[11px] text-muted-foreground/70 truncate max-w-[320px]" title={b.sourceRef}>
                        {b.sourceRef}
                      </span>
                    )}
                    {b.error && (
                      <span
                        className="text-xs text-red-500 truncate max-w-[320px] cursor-help"
                        title={b.error}
                      >
                        {b.error}
                      </span>
                    )}
                  </div>
                </TableCell>
                <TableCell className="text-right tabular-nums text-sm">
                  {b.recipientCount > 0 ? b.recipientCount.toLocaleString() : "—"}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">{fmtDate(b.createdAt)}</TableCell>
                <TableCell className="text-sm text-muted-foreground">{fmtDate(b.sentAt)}</TableCell>
                <TableCell>
                  {canSend ? (
                    <Button
                      size="sm"
                      disabled={isBusy || busy !== null}
                      onClick={() => onSend(b)}
                      className="gap-1.5"
                    >
                      {isBusy ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Send className="h-3.5 w-3.5" />
                      )}
                      Send
                    </Button>
                  ) : (
                    <span className="text-muted-foreground/30 text-xs">—</span>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

"use client";

import { useState } from "react";
import { Check, Copy, KeyRound, LoaderCircle, Plus, ShieldOff } from "lucide-react";
import {
  createMarketMovesToken,
  revokeMarketMovesToken,
  type MarketMovesToken,
} from "~/app/actions/admin/marketMovesTokens";
import {
  DEFAULT_TOKEN_EXPIRY_DAYS,
  TOKEN_ENV_VAR,
  TOKEN_EXPIRY_CHOICES,
  expiryLabel,
} from "~/@/lib/market-moves/tokens";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Create, list and revoke the tokens a market-moves workflow posts with.
 *
 * A new token is shown once, in the reveal panel, and dropped from the page's
 * state when the panel is dismissed: the API keeps only its hash, so nothing can
 * show it again. Revoking asks for a second click in the row rather than a
 * browser confirm dialog.
 */
export interface MarketMovesTokensClientProps {
  initial: MarketMovesToken[];
  maxActive: number;
  /** The API origin the workflow posts to, for the example request. */
  apiOrigin: string;
  /** Set when the list could not be read. */
  loadError?: string;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-AU", {
    timeZone: "Australia/Sydney",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function StatusBadge({ status }: { status: MarketMovesToken["status"] }) {
  if (status === "active") {
    return (
      <Badge
        variant="secondary"
        className="bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400"
      >
        active
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-muted-foreground">
      {status}
    </Badge>
  );
}

export function MarketMovesTokensClient({
  initial,
  maxActive,
  apiOrigin,
  loadError,
}: MarketMovesTokensClientProps) {
  const [tokens, setTokens] = useState<MarketMovesToken[]>(initial);
  const [name, setName] = useState("");
  const [expiry, setExpiry] = useState<number>(DEFAULT_TOKEN_EXPIRY_DAYS);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<{ secret: string; token: MarketMovesToken } | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState<number | null>(null);
  const [revoking, setRevoking] = useState<number | null>(null);

  const active = tokens.filter((t) => t.status === "active").length;
  const atCap = maxActive > 0 && active >= maxActive;

  async function onCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setCreating(true);
    const res = await createMarketMovesToken({ name, expiresInDays: expiry });
    setCreating(false);
    if (!res.ok) {
      const detail = res.fields?.map((f) => `${f.field}: ${f.message}`).join("; ");
      setError(detail ? `${res.error} (${detail})` : res.error);
      return;
    }
    setTokens((prev) => [res.token, ...prev]);
    setRevealed(res.secret ? { secret: res.secret, token: res.token } : null);
    setCopied(false);
    setName("");
  }

  async function onCopy() {
    if (!revealed) return;
    try {
      await navigator.clipboard.writeText(revealed.secret);
      setCopied(true);
    } catch {
      setCopied(false);
      setError("Copying failed; select the token and copy it by hand.");
    }
  }

  async function onRevoke(id: number) {
    setError(null);
    setRevoking(id);
    const res = await revokeMarketMovesToken(id);
    setRevoking(null);
    setConfirming(null);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setTokens((prev) => prev.map((t) => (t.id === id ? res.token : t)));
    if (revealed?.token.id === id) setRevealed(null);
  }

  return (
    <div className="space-y-6">
      {loadError ? (
        <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          The tokens could not be read: {loadError}
        </p>
      ) : null}

      {revealed ? (
        <section
          aria-labelledby="new-token-heading"
          className="space-y-3 rounded-lg border border-amber-500/50 bg-amber-50 p-4 dark:bg-amber-950/20"
        >
          <h3 id="new-token-heading" className="flex items-center gap-2 font-semibold">
            <KeyRound className="h-4 w-4" aria-hidden />
            Copy “{revealed.token.name}” now. It will not be shown again.
          </h3>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <code
              data-testid="new-token"
              className="min-w-0 flex-1 select-all break-all rounded-md border bg-background px-3 py-2 font-mono text-sm"
            >
              {revealed.secret}
            </code>
            <Button type="button" variant="outline" onClick={onCopy} className="shrink-0 gap-1.5">
              {copied ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">
            Give it to the workflow as <code className="font-mono">{TOKEN_ENV_VAR}</code> (a Claude Code
            routine&apos;s environment variables, a GitHub Actions or Cuttlefish secret). Never put it in a
            prompt, a file or a commit. Shorted keeps only its hash: if it is lost, revoke it and create
            another.
          </p>
          <pre className="overflow-x-auto rounded-md border bg-background p-3 font-mono text-xs leading-relaxed">
            {`curl -sS ${apiOrigin}/v1/market-moves \\
  -H "Authorization: Bearer $${TOKEN_ENV_VAR}" \\
  -H "Content-Type: application/json" \\
  -d @move.json`}
          </pre>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setRevealed(null);
              setCopied(false);
            }}
          >
            I have stored it
          </Button>
        </section>
      ) : null}

      <form onSubmit={onCreate} className="grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end">
        <div className="space-y-1.5">
          <Label htmlFor="token-name">Name</Label>
          <Input
            id="token-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Claude market-moves routine"
            maxLength={80}
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="token-expiry">Expires</Label>
          <select
            id="token-expiry"
            value={expiry}
            onChange={(e) => setExpiry(Number(e.target.value))}
            className="h-10 rounded-md border border-input bg-background px-3 text-sm"
          >
            {TOKEN_EXPIRY_CHOICES.map((days) => (
              <option key={days} value={days}>
                {expiryLabel(days)}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit" disabled={creating || atCap || name.trim() === ""} className="gap-1.5">
          {creating ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden /> : <Plus className="h-4 w-4" aria-hidden />}
          Create token
        </Button>
      </form>
      <p className="text-xs text-muted-foreground">
        {active} of {maxActive || "—"} tokens active.
        {atCap ? " Revoke one to create another." : null}
      </p>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {tokens.length === 0 ? (
        <p className="text-sm text-muted-foreground">No tokens yet. Create one for the workflow above.</p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Token</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tokens.map((t) => (
                <TableRow key={t.id} data-token-id={t.id}>
                  <TableCell className="font-medium">{t.name}</TableCell>
                  <TableCell>
                    <code className="font-mono text-xs">{t.prefix}…</code>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={t.status} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    {fmtDate(t.createdAt)}
                    <br />
                    {t.createdBy}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    {t.lastUsedAt ? fmtDate(t.lastUsedAt) : "Never"}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    {t.status === "revoked" ? `Revoked ${fmtDate(t.revokedAt)}` : t.expiresAt ? fmtDate(t.expiresAt) : "Never"}
                  </TableCell>
                  <TableCell className="text-right">
                    {t.status === "revoked" ? null : confirming === t.id ? (
                      <span className="inline-flex gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="destructive"
                          disabled={revoking === t.id}
                          onClick={() => onRevoke(t.id)}
                        >
                          {revoking === t.id ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
                          Revoke {t.name}
                        </Button>
                        <Button type="button" size="sm" variant="ghost" onClick={() => setConfirming(null)}>
                          Cancel
                        </Button>
                      </span>
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="gap-1"
                        onClick={() => setConfirming(t.id)}
                      >
                        <ShieldOff className="h-3.5 w-3.5" aria-hidden />
                        Revoke
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

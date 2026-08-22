"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { ArrowRight, Check, Clock, LogIn, Mail, RefreshCw, Sparkles } from "lucide-react";

import { Button } from "~/@/components/ui/button";
import { Card } from "~/@/components/ui/card";
import { cn } from "~/@/lib/utils";
import { eyebrow, lede, sectionTitle } from "~/@/lib/typography";
import {
  DEFAULT_UPGRADE_URL,
  type RateLimitInfo,
  type RateLimitKind,
  type RateLimitTier,
} from "~/@/lib/retry";

// ---------------------------------------------------------------------------
// Formatting helpers — all defensive. A missing or garbage value renders
// nothing rather than "NaN seconds" or "Invalid Date".
// ---------------------------------------------------------------------------

/** True for a value we can safely treat as a unix-seconds timestamp. */
function isUsableTimestamp(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0 &&
    // Guard against milliseconds being passed where seconds are expected, and
    // against absurd far-future values. ~1e10 s is the year 2286.
    value < 1e10
  );
}

/**
 * Seconds → a short, human countdown ("45s", "2m 05s", "1h 12m").
 * Returns null for anything unusable so callers can omit the countdown.
 */
export function formatCountdown(seconds: number | null | undefined): string | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
    return null;
  }
  const total = Math.ceil(seconds);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  if (minutes < 60) return `${minutes}m ${String(secs).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours < 24) return `${hours}h ${String(mins).padStart(2, "0")}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

/**
 * Unix seconds → "3 September". Returns null when the timestamp is missing or
 * nonsensical, so the caller can drop the sentence entirely.
 */
export function formatResetDate(timestamp: number | null | undefined): string | null {
  if (!isUsableTimestamp(timestamp)) return null;
  const date = new Date(timestamp * 1000);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { day: "numeric", month: "long" });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface RateLimitNoticeProps {
  /** Parsed rate-limit payload. Every field is optional. */
  info: RateLimitInfo;
  /**
   * `inline` degrades a single widget in place — small, quiet, never alarming.
   * `page` is the full standalone panel (also used by /rate-limit).
   */
  variant?: "inline" | "page";
  /** Retry handler. Omit to hide retry affordances entirely. */
  onRetry?: () => void;
  /** Whether a retry is currently in flight. */
  isRetrying?: boolean;
  /**
   * Override the caller tier. When absent we use `info.tier`, falling back to
   * the session (authenticated → free, unauthenticated → anonymous).
   */
  tier?: RateLimitTier;
  /** Override the sign-in destination. */
  signInHref?: string;
  /** Override the upgrade destination. Defaults to `info.upgradeUrl` → /pricing. */
  upgradeUrl?: string;
  className?: string;
}

/** What a paid plan buys — the substance behind the upgrade CTA. */
const PAID_BENEFITS = [
  "Unlimited requests — no monthly ceiling",
  "Full history and bulk exports",
  "Programmatic API access with a personal token",
] as const;

export function RateLimitNotice({
  info,
  variant = "inline",
  onRetry,
  isRetrying = false,
  tier,
  signInHref,
  upgradeUrl,
  className,
}: RateLimitNoticeProps) {
  const { status } = useSession();

  const resolvedTier: RateLimitTier =
    tier ??
    info.tier ??
    (status === "authenticated" ? "free" : "anonymous");

  const kind: RateLimitKind = info.kind ?? "unknown";
  const isMonthly = kind === "monthly";

  const resolvedUpgradeUrl = upgradeUrl ?? info.upgradeUrl ?? DEFAULT_UPGRADE_URL;

  // Sign-in bounces back to wherever the user already was.
  const resolvedSignInHref = useMemo(() => {
    if (signInHref) return signInHref;
    const path =
      typeof window !== "undefined"
        ? `${window.location.pathname}${window.location.search}`
        : "/";
    return `/signin?callbackUrl=${encodeURIComponent(path || "/")}`;
  }, [signInHref]);

  // --- live countdown ------------------------------------------------------
  // Per-minute limits count down to Retry-After / X-RateLimit-Reset; monthly
  // counts down to the monthly reset. Either may be absent.
  const targetSeconds = useMemo(() => {
    if (isMonthly) {
      return isUsableTimestamp(info.monthlyResetAt) ? info.monthlyResetAt : null;
    }
    if (isUsableTimestamp(info.resetAt)) return info.resetAt;
    if (typeof info.retryAfter === "number" && info.retryAfter >= 0) {
      return Math.floor(Date.now() / 1000) + info.retryAfter;
    }
    return null;
  }, [isMonthly, info.monthlyResetAt, info.resetAt, info.retryAfter]);

  const computeRemaining = useCallback(() => {
    if (targetSeconds === null) return null;
    return Math.max(0, targetSeconds - Math.floor(Date.now() / 1000));
  }, [targetSeconds]);

  const [remaining, setRemaining] = useState<number | null>(computeRemaining);

  useEffect(() => {
    setRemaining(computeRemaining());
    if (targetSeconds === null) return;
    const timer = setInterval(() => setRemaining(computeRemaining()), 1000);
    return () => clearInterval(timer);
  }, [computeRemaining, targetSeconds]);

  const countdown = formatCountdown(remaining);
  const canRetryNow = remaining === null || remaining <= 0;

  // -------------------------------------------------------------------------
  // Inline / compact
  // -------------------------------------------------------------------------
  if (variant === "inline") {
    if (isMonthly) {
      return (
        <div
          role="status"
          className={cn(
            "flex flex-col gap-3 rounded-lg border border-border/70 bg-muted/40 p-4",
            "sm:flex-row sm:items-center sm:justify-between",
            className
          )}
        >
          <div className="min-w-0">
            <p className="text-sm font-medium">
              You&apos;ve used your monthly request allowance
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              <MonthlyUsageSentence info={info} />
            </p>
          </div>
          <TierCta
            tier={resolvedTier}
            upgradeUrl={resolvedUpgradeUrl}
            signInHref={resolvedSignInHref}
            size="sm"
          />
        </div>
      );
    }

    // Per-minute (and unclassified): deliberately undramatic. This is a
    // self-healing pause, not an error — no warning colour, no alarm icon.
    return (
      <div
        role="status"
        aria-live="polite"
        className={cn(
          "flex items-center gap-2.5 rounded-lg border border-border/60 bg-muted/30 px-3 py-2.5",
          "text-sm text-muted-foreground",
          className
        )}
      >
        <RefreshCw
          className={cn("h-3.5 w-3.5 shrink-0", !canRetryNow && "animate-spin")}
          aria-hidden
        />
        <span className="min-w-0 flex-1">
          Just a moment — refreshing
          {countdown ? (
            <>
              {" "}
              in <span className="font-mono tabular-nums">{countdown}</span>
            </>
          ) : (
            " shortly"
          )}
          .
        </span>
        {onRetry && canRetryNow && (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 shrink-0 px-2 text-xs"
            onClick={onRetry}
            disabled={isRetrying}
          >
            {isRetrying ? "Retrying…" : "Retry now"}
          </Button>
        )}
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Full page panel
  // -------------------------------------------------------------------------
  return (
    <Card className={cn("mx-auto w-full max-w-lg p-6 sm:p-8", className)}>
      <p className={eyebrow}>
        {isMonthly ? "Monthly allowance" : "Briefly rate limited"}
      </p>

      <h1 className={cn(sectionTitle, "mt-2")}>
        {isMonthly
          ? "You've used this month's requests"
          : "Just a moment"}
      </h1>

      <p className={cn(lede, "text-sm")}>
        {isMonthly ? (
          <>
            Your allowance resets automatically
            {formatResetDate(info.monthlyResetAt)
              ? ` on ${formatResetDate(info.monthlyResetAt)}`
              : " at the start of next month"}
            .{" "}
            {resolvedTier === "paid"
              ? "That shouldn't happen on a paid plan — get in touch and we'll sort it out."
              : resolvedTier === "anonymous"
                ? "Signing in raises your limit straight away."
                : "Upgrade to keep going now."}
          </>
        ) : (
          <>
            We&apos;re briefly limiting requests to keep the site fast for
            everyone. Nothing is broken — this clears itself in under a minute.
          </>
        )}
      </p>

      {/* Usage / countdown detail */}
      <div className="mt-6 rounded-lg border border-border/60 bg-muted/30 p-4">
        {isMonthly ? (
          <MonthlyUsageBlock info={info} />
        ) : (
          <div className="flex items-center gap-3">
            <Clock className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            <div className="min-w-0">
              {countdown && !canRetryNow ? (
                <p className="text-sm">
                  Retrying in{" "}
                  <span className="font-mono text-base font-semibold tabular-nums">
                    {countdown}
                  </span>
                </p>
              ) : (
                <p className="text-sm">Ready to try again.</p>
              )}
              {typeof info.limit === "number" && info.limit > 0 && (
                <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                  Limit: {info.limit.toLocaleString()} requests/minute
                </p>
              )}
            </div>
          </div>
        )}
      </div>

      {/* What upgrading gives — only where it's the actual remedy. */}
      {isMonthly && resolvedTier !== "paid" && (
        <ul className="mt-5 space-y-2">
          {PAID_BENEFITS.map((benefit) => (
            <li key={benefit} className="flex items-start gap-2.5 text-sm">
              <Check
                className="mt-0.5 h-4 w-4 shrink-0 text-primary"
                aria-hidden
              />
              <span>{benefit}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-6 flex flex-col gap-2.5">
        <TierCta
          tier={resolvedTier}
          upgradeUrl={resolvedUpgradeUrl}
          signInHref={resolvedSignInHref}
          isMonthly={isMonthly}
          className="w-full"
        />

        {onRetry && !isMonthly && (
          <Button
            variant="outline"
            className="w-full"
            onClick={onRetry}
            disabled={isRetrying || !canRetryNow}
          >
            <RefreshCw
              className={cn("mr-2 h-4 w-4", isRetrying && "animate-spin")}
              aria-hidden
            />
            {isRetrying
              ? "Retrying…"
              : canRetryNow
                ? "Try again"
                : `Try again in ${countdown ?? "a moment"}`}
          </Button>
        )}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Sub-parts
// ---------------------------------------------------------------------------

/** "1,847 of 2,000 requests used · resets 1 September" — omits unknown parts. */
function MonthlyUsageSentence({ info }: { info: RateLimitInfo }) {
  const hasNumbers =
    typeof info.monthlyUsed === "number" && typeof info.monthlyLimit === "number";
  const resetDate = formatResetDate(info.monthlyResetAt);

  if (!hasNumbers && !resetDate) {
    return <>Your allowance resets at the start of next month.</>;
  }

  return (
    <>
      {hasNumbers && (
        <span className="font-mono tabular-nums">
          {info.monthlyUsed!.toLocaleString()} of{" "}
          {info.monthlyLimit!.toLocaleString()}
        </span>
      )}
      {hasNumbers && " requests used"}
      {resetDate && (hasNumbers ? ` · resets ${resetDate}` : `Resets ${resetDate}`)}
    </>
  );
}

/** Usage bar + numbers for the full panel. Degrades when numbers are absent. */
function MonthlyUsageBlock({ info }: { info: RateLimitInfo }) {
  const used = info.monthlyUsed;
  const limit = info.monthlyLimit;
  const hasNumbers =
    typeof used === "number" &&
    typeof limit === "number" &&
    Number.isFinite(used) &&
    Number.isFinite(limit) &&
    limit > 0;

  const percent = hasNumbers ? Math.min(100, Math.max(0, (used / limit) * 100)) : 100;
  const resetDate = formatResetDate(info.monthlyResetAt);

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-mono text-xs uppercase tracking-[0.12em] text-muted-foreground">
          Requests used
        </span>
        {hasNumbers && (
          <span className="font-mono text-sm tabular-nums">
            {used.toLocaleString()} / {limit.toLocaleString()}
          </span>
        )}
      </div>
      {/* Plain div bar rather than the Progress primitive: this renders inside
          error boundaries and the standalone route, and a non-interactive bar
          keeps the dependency surface (and the bundle) minimal. */}
      <div
        className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-border"
        role="progressbar"
        aria-valuenow={Math.round(percent)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Monthly request usage"
      >
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-500"
          style={{ width: `${percent}%` }}
        />
      </div>
      {resetDate && (
        <p className="mt-2 text-xs text-muted-foreground">Resets on {resetDate}</p>
      )}
    </div>
  );
}

/**
 * The tier-appropriate call to action.
 *  - anonymous → sign in (free, instant, higher limits)
 *  - free      → upgrade
 *  - paid      → contact us; a paid caller hitting a limit is our problem, not
 *                something they can buy their way out of.
 */
function TierCta({
  tier,
  upgradeUrl,
  signInHref,
  isMonthly = true,
  size,
  className,
}: {
  tier: RateLimitTier;
  upgradeUrl: string;
  signInHref: string;
  isMonthly?: boolean;
  size?: "sm";
  className?: string;
}) {
  if (tier === "paid") {
    // No /contact route exists; support@ is the canonical channel (see
    // /privacy, /disclaimer). mailto must be a plain anchor, not next/link.
    return (
      <Button variant="outline" size={size} asChild className={className}>
        <a href="mailto:support@shorted.com.au?subject=Rate%20limit%20on%20my%20account">
          <Mail className="mr-2 h-4 w-4" aria-hidden />
          Contact support
        </a>
      </Button>
    );
  }

  if (tier === "anonymous") {
    return (
      <Button size={size} asChild className={className}>
        <Link href={signInHref}>
          <LogIn className="mr-2 h-4 w-4" aria-hidden />
          Sign in for higher limits
        </Link>
      </Button>
    );
  }

  // free
  return (
    <Button size={size} asChild className={className}>
      <Link href={upgradeUrl}>
        <Sparkles className="mr-2 h-4 w-4" aria-hidden />
        {isMonthly ? "Upgrade for unlimited requests" : "See plans"}
        <ArrowRight className="ml-2 h-4 w-4" aria-hidden />
      </Link>
    </Button>
  );
}

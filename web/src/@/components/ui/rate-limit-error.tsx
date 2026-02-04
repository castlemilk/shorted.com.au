"use client";

import { useState, useEffect, useCallback } from "react";
import { Clock, AlertTriangle, RefreshCw, Zap } from "lucide-react";
import { Button } from "~/@/components/ui/button";
import { Card } from "~/@/components/ui/card";
import { Progress } from "~/@/components/ui/progress";
import { type RateLimitInfo } from "~/@/lib/retry";

interface RateLimitErrorProps {
  /** Rate limit information from the error */
  rateLimitInfo: RateLimitInfo;
  /** Callback to retry the request */
  onRetry?: () => void;
  /** Whether a retry is in progress */
  isRetrying?: boolean;
  /** Compact mode for inline display */
  compact?: boolean;
}

/**
 * Formats seconds into a human-readable duration
 */
function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${Math.ceil(seconds)} second${seconds !== 1 ? "s" : ""}`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.ceil(seconds % 60);
  if (minutes < 60) {
    return remainingSeconds > 0
      ? `${minutes}m ${remainingSeconds}s`
      : `${minutes} minute${minutes !== 1 ? "s" : ""}`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0
    ? `${hours}h ${remainingMinutes}m`
    : `${hours} hour${hours !== 1 ? "s" : ""}`;
}

/**
 * Formats a Unix timestamp into a readable date string
 */
function formatResetTime(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export function RateLimitError({
  rateLimitInfo,
  onRetry,
  isRetrying = false,
  compact = false,
}: RateLimitErrorProps) {
  const [countdown, setCountdown] = useState<number | null>(null);
  const [autoRetryEnabled, setAutoRetryEnabled] = useState(false);

  // Calculate initial countdown from retryAfter or resetAt
  const getInitialCountdown = useCallback(() => {
    if (rateLimitInfo.retryAfter) {
      return rateLimitInfo.retryAfter;
    }
    if (rateLimitInfo.resetAt) {
      const now = Math.floor(Date.now() / 1000);
      return Math.max(0, rateLimitInfo.resetAt - now);
    }
    return 60; // Default to 60 seconds
  }, [rateLimitInfo.retryAfter, rateLimitInfo.resetAt]);

  // Initialize countdown
  useEffect(() => {
    setCountdown(getInitialCountdown());
  }, [getInitialCountdown]);

  // Countdown timer
  useEffect(() => {
    if (countdown === null || countdown <= 0) return;

    const timer = setInterval(() => {
      setCountdown((prev) => {
        if (prev === null || prev <= 1) {
          // Auto-retry when countdown reaches 0
          if (autoRetryEnabled && onRetry) {
            onRetry();
          }
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [countdown, autoRetryEnabled, onRetry]);

  const isMonthlyLimit =
    rateLimitInfo.monthlyLimit &&
    rateLimitInfo.monthlyUsed &&
    rateLimitInfo.monthlyUsed >= rateLimitInfo.monthlyLimit;

  const usagePercent = rateLimitInfo.monthlyLimit
    ? Math.min(
        100,
        ((rateLimitInfo.monthlyUsed ?? 0) / rateLimitInfo.monthlyLimit) * 100
      )
    : 0;

  if (compact) {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
        <AlertTriangle className="h-5 w-5 flex-shrink-0" />
        <div className="flex-1 text-sm">
          <span className="font-medium">Rate limit exceeded.</span>
          {countdown !== null && countdown > 0 && (
            <span className="ml-1">Retry in {formatDuration(countdown)}</span>
          )}
        </div>
        {onRetry && countdown === 0 && (
          <Button
            size="sm"
            variant="outline"
            onClick={onRetry}
            disabled={isRetrying}
            className="h-7 border-amber-300 hover:bg-amber-100 dark:border-amber-700 dark:hover:bg-amber-900"
          >
            {isRetrying ? (
              <RefreshCw className="h-3 w-3 animate-spin" />
            ) : (
              "Retry"
            )}
          </Button>
        )}
      </div>
    );
  }

  return (
    <Card className="mx-auto max-w-md overflow-hidden">
      {/* Header with gradient */}
      <div className="bg-gradient-to-r from-amber-500 to-orange-500 p-6 text-white">
        <div className="flex items-center gap-3">
          <div className="rounded-full bg-white/20 p-3">
            <Zap className="h-6 w-6" />
          </div>
          <div>
            <h3 className="text-lg font-semibold">
              {isMonthlyLimit ? "Monthly Limit Reached" : "Rate Limit Exceeded"}
            </h3>
            <p className="text-sm text-white/80">
              {isMonthlyLimit
                ? "You've used your monthly API quota"
                : "Too many requests in a short time"}
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-6 p-6">
        {/* Monthly usage progress */}
        {rateLimitInfo.monthlyLimit && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Monthly Usage</span>
              <span className="font-medium">
                {rateLimitInfo.monthlyUsed?.toLocaleString() ?? 0} /{" "}
                {rateLimitInfo.monthlyLimit.toLocaleString()}
              </span>
            </div>
            <Progress value={usagePercent} className="h-2" />
            {rateLimitInfo.monthlyResetAt && (
              <p className="text-xs text-muted-foreground">
                Resets on {formatResetTime(rateLimitInfo.monthlyResetAt)}
              </p>
            )}
          </div>
        )}

        {/* Per-minute info */}
        {rateLimitInfo.limit && !isMonthlyLimit && (
          <div className="rounded-lg bg-muted/50 p-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Clock className="h-4 w-4" />
              <span>
                Limit: {rateLimitInfo.limit} requests per minute
              </span>
            </div>
          </div>
        )}

        {/* Countdown timer */}
        {!isMonthlyLimit && countdown !== null && countdown > 0 && (
          <div className="text-center">
            <div className="mb-2 text-4xl font-bold tabular-nums text-amber-600">
              {formatDuration(countdown)}
            </div>
            <p className="text-sm text-muted-foreground">until you can retry</p>
          </div>
        )}

        {/* Monthly limit reached - different messaging */}
        {isMonthlyLimit && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-center dark:border-amber-800 dark:bg-amber-950">
            <p className="text-sm text-amber-800 dark:text-amber-200">
              Your monthly API quota has been reached. Consider upgrading your
              plan for higher limits.
            </p>
          </div>
        )}

        {/* Action buttons */}
        <div className="flex flex-col gap-3">
          {onRetry && !isMonthlyLimit && (
            <>
              <Button
                onClick={onRetry}
                disabled={isRetrying || (countdown !== null && countdown > 0)}
                className="w-full"
              >
                {isRetrying ? (
                  <>
                    <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                    Retrying...
                  </>
                ) : countdown !== null && countdown > 0 ? (
                  <>
                    <Clock className="mr-2 h-4 w-4" />
                    Wait {formatDuration(countdown)}
                  </>
                ) : (
                  <>
                    <RefreshCw className="mr-2 h-4 w-4" />
                    Try Again
                  </>
                )}
              </Button>

              {countdown !== null && countdown > 0 && (
                <label className="flex cursor-pointer items-center justify-center gap-2 text-sm text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={autoRetryEnabled}
                    onChange={(e) => setAutoRetryEnabled(e.target.checked)}
                    className="rounded border-gray-300"
                  />
                  Auto-retry when ready
                </label>
              )}
            </>
          )}
        </div>

        {/* Help text */}
        <p className="text-center text-xs text-muted-foreground">
          {isMonthlyLimit
            ? "Need more requests? Contact us about upgrading your plan."
            : "Rate limits help ensure fair usage for all users."}
        </p>
      </div>
    </Card>
  );
}

/**
 * Inline rate limit warning for showing in widgets/cards
 */
export function RateLimitWarning({
  remaining,
  limit,
}: {
  remaining: number;
  limit: number;
}) {
  const percentUsed = ((limit - remaining) / limit) * 100;

  // Only show warning when usage is high (>80%)
  if (percentUsed < 80) return null;

  return (
    <div className="flex items-center gap-2 rounded-md bg-amber-50 px-3 py-1.5 text-xs text-amber-700 dark:bg-amber-950 dark:text-amber-300">
      <AlertTriangle className="h-3 w-3" />
      <span>
        {remaining} request{remaining !== 1 ? "s" : ""} remaining this minute
      </span>
    </div>
  );
}

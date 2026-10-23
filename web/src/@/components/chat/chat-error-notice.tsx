"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Button, buttonVariants } from "~/@/components/ui/button";
import { chatErrorCopy, type ChatErrorInfo } from "~/@/lib/chat-errors";
import { cn } from "~/@/lib/utils";

interface ChatErrorNoticeProps {
  error: ChatErrorInfo;
  /** Offered for `unavailable` only: a limit or a sign-in is not fixed by asking again. */
  onRetry?: () => void;
  /**
   * Offered for `invalid_request` while a conversation is open: a refused send
   * there is a conversation the service no longer has, and asking again with
   * the same id cannot work. A new chat is the way on.
   */
  onNewChat?: () => void;
}

/**
 * Says what went wrong, in words, with the one action that helps. The raw
 * contract is never rendered: the copy is built from the error's code and
 * fields in `chatErrorCopy`.
 */
export function ChatErrorNotice({ error, onRetry, onNewChat }: ChatErrorNoticeProps) {
  const pathname = usePathname() ?? "/chat";
  const copy = chatErrorCopy(error);

  return (
    <div
      role="alert"
      className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm"
    >
      <p className="font-medium text-foreground">{copy.title}</p>
      {copy.detail && (
        <p className="mt-0.5 text-xs text-muted-foreground">{copy.detail}</p>
      )}
      {error.code === "premium_required" && (
        <Link href="/pricing" className={cn(buttonVariants({ size: "sm" }), "mt-2")}>
          See plans
        </Link>
      )}
      {error.code === "unauthenticated" && (
        <Link
          href={`/signin?callbackUrl=${encodeURIComponent(pathname)}`}
          className={cn(buttonVariants({ size: "sm" }), "mt-2")}
        >
          Sign in
        </Link>
      )}
      {error.code === "unavailable" && onRetry && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-2"
          onClick={onRetry}
        >
          Try again
        </Button>
      )}
      {error.code === "invalid_request" && onNewChat && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-2"
          onClick={onNewChat}
        >
          Start a new chat
        </Button>
      )}
    </div>
  );
}

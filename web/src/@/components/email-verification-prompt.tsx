"use client";

import { useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";

import { Button } from "~/@/components/ui/button";
import { sendAlertVerificationEmail } from "~/app/actions/email-verification";

/**
 * Lets an email/password account verify its address without signing out. Shown only
 * while the session says the address is unverified. It sends the verification email
 * and refreshes the session (next-auth update(), which re-reads Firebase), so the
 * verified state appears on this page once the user has clicked the link.
 */
export function EmailVerificationPrompt({
  showIntro = false,
}: {
  /** Adds "Verify <address> to receive alert emails." for a page with no such sentence. */
  showIntro?: boolean;
} = {}) {
  const { data: session, status, update } = useSession();
  const email = session?.user?.email ?? null;
  const signedIn = status === "authenticated" && !!email;
  const unverified = signedIn && session?.user?.emailVerified !== true;

  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [justVerified, setJustVerified] = useState(false);
  const checkedOnMount = useRef(false);

  // A silent check when the page opens: a user who clicked the link since their last
  // visit is verified without needing to press Refresh. It runs once per mount.
  useEffect(() => {
    if (!unverified || checkedOnMount.current) return;
    checkedOnMount.current = true;
    void update().then((next) => {
      if (next?.user?.emailVerified === true) setJustVerified(true);
    });
  }, [unverified, update]);

  if (!signedIn) return null;
  if (justVerified) {
    return (
      <p role="status" className="text-sm leading-6 text-muted-foreground">
        <span className="font-medium text-foreground">Verified.</span> Alerts
        will be emailed to{" "}
        <span className="font-medium text-foreground">{email}</span>.
      </p>
    );
  }
  if (!unverified) return null;

  async function sendVerification() {
    setBusy(true);
    setMessage(null);
    try {
      const result = await sendAlertVerificationEmail();
      if (!result.ok) {
        setMessage(
          result.retryAfterSeconds
            ? `${result.error} Try again in ${Math.ceil(result.retryAfterSeconds / 60)} minute(s).`
            : result.error,
        );
        return;
      }
      if (result.status === "already-verified") {
        await refresh();
        return;
      }
      setMessage(
        `Sent. Check your inbox at ${email}, then select Refresh here. No sign-out is needed.`,
      );
    } catch {
      setMessage("Could not send the email. Try again shortly.");
    } finally {
      setBusy(false);
    }
  }

  async function refresh() {
    setBusy(true);
    setMessage(null);
    try {
      const next = await update();
      if (next?.user?.emailVerified === true) {
        setJustVerified(true);
      } else {
        setMessage(
          "Not verified yet. Open the link in the email, then select Refresh.",
        );
      }
    } catch {
      setMessage("Could not check the account. Try again shortly.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 rounded-md border border-border/60 bg-background/60 p-4">
      {showIntro ? (
        <p className="text-sm leading-6 text-muted-foreground">
          Verify <span className="font-medium text-foreground">{email}</span> to
          receive alert emails. Until it is verified, alerts are recorded but
          not emailed.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          onClick={() => void sendVerification()}
          disabled={busy}
        >
          {busy ? "Sending..." : "Send verification email"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void refresh()}
          disabled={busy}
        >
          I&apos;ve verified, refresh
        </Button>
      </div>
      {message ? (
        <p role="status" className="text-sm text-muted-foreground">
          {message}
        </p>
      ) : null}
    </div>
  );
}

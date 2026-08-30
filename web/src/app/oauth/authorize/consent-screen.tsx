"use client";

import { useState } from "react";
import { AlertTriangle, Check, Lock, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  approveAuthorization,
  denyAuthorization,
  type AuthorizationRequest,
  type ConsentDescribeResult,
} from "./actions";

/**
 * The consent screen itself.
 *
 * It is not an auto-approving redirect, and that is the whole point: this is
 * the only moment a human is in the loop, so it has to be a moment. It names
 * the client, shows the exact URI the credential will be delivered to, lists
 * what the client will be able to read in plain language, and requires an
 * explicit click.
 *
 * The redirect URI is on the screen because it is the one thing that decides
 * where a credential ends up. A screen that shows "Claude wants access" and
 * hides the destination cannot be used to notice that "Claude" is delivering to
 * somebody else's callback.
 */
export function ConsentScreen({
  request,
  described,
  userEmail,
}: {
  request: AuthorizationRequest;
  described: ConsentDescribeResult;
  userEmail: string | null;
}) {
  const [pending, setPending] = useState<null | "approve" | "deny">(null);
  const [failure, setFailure] = useState<string | null>(null);

  // A refused request never reaches the decision UI. There is nothing for a
  // human to decide about a request the authorization server will not honour,
  // and rendering an Approve button over one would teach people to click
  // through errors.
  if (!described.ok) {
    return (
      <Shell>
        <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
          <div className="space-y-1">
            <h1 className="text-base font-semibold">
              This authorization request cannot be completed
            </h1>
            <p className="text-sm text-muted-foreground">
              {described.description}
            </p>
            <p className="font-mono text-xs text-muted-foreground">
              {described.error}
            </p>
          </div>
        </div>
        <p className="text-sm text-muted-foreground">
          Nothing has been shared. You can close this window and try connecting
          again from the application.
        </p>
      </Shell>
    );
  }

  const { details } = described;
  const clientLabel = details.clientName || details.clientId;

  async function decide(decision: "approve" | "deny") {
    setPending(decision);
    setFailure(null);
    const result =
      decision === "approve"
        ? await approveAuthorization(request)
        : await denyAuthorization(request);

    if (!result.ok) {
      setPending(null);
      setFailure(result.description);
      return;
    }
    // A full navigation, not a router push: the destination belongs to the
    // OAuth client (often a loopback listener on the user's own machine) and
    // is not a route in this app.
    window.location.href = result.redirectTo;
  }

  return (
    <Shell>
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Lock className="h-4 w-4" />
          <span>Authorize access</span>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">
          <span className="break-words">{clientLabel}</span> wants to access
          your Shorted data
        </h1>
        {userEmail ? (
          <p className="text-sm text-muted-foreground">
            You are signed in as <span className="font-medium">{userEmail}</span>.
          </p>
        ) : null}
      </div>

      <section className="space-y-3 rounded-lg border p-4">
        <h2 className="text-sm font-semibold">It will be able to</h2>
        <ul className="space-y-2">
          {details.scopes.map((line) => (
            <li key={line.scope} className="flex items-start gap-2 text-sm">
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
              <span>
                {line.description}
                <span className="ml-1 font-mono text-xs text-muted-foreground">
                  ({line.scope})
                </span>
              </span>
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">
          Read-only. Shorted&rsquo;s MCP tools cannot change anything in your
          account, and this does not grant access to your billing or API keys.
        </p>
      </section>

      {/* Where the credential goes. Verbatim, unshortened, and never a link —
          a clickable destination on a consent screen is a phishing surface. */}
      <section className="space-y-2 rounded-lg border p-4">
        <h2 className="text-sm font-semibold">Access will be delivered to</h2>
        <p className="break-all font-mono text-xs">{details.redirectUri}</p>
        <p className="text-xs text-muted-foreground">
          Only approve if you recognise this address as belonging to the
          application you are connecting.
        </p>
      </section>

      {failure ? (
        <p
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
        >
          {failure}
        </p>
      ) : null}

      <div className="flex flex-col gap-2 sm:flex-row-reverse">
        <Button
          onClick={() => void decide("approve")}
          disabled={pending !== null}
          className="sm:min-w-40"
        >
          {pending === "approve" ? "Authorizing…" : "Approve"}
        </Button>
        <Button
          variant="outline"
          onClick={() => void decide("deny")}
          disabled={pending !== null}
          className="sm:min-w-40"
        >
          <X className="mr-1 h-4 w-4" />
          {pending === "deny" ? "Cancelling…" : "Cancel"}
        </Button>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-[70vh] w-full max-w-xl flex-col justify-center gap-6 px-4 py-12">
      {children}
    </main>
  );
}

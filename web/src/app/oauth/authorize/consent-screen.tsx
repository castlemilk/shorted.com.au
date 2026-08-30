"use client";

import { useState } from "react";
import Image from "next/image";
import { AlertTriangle, Check, Loader2, Lock, X } from "lucide-react";

import { AsciiFire } from "@/components/ui/ascii-fire";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  approveAuthorization,
  denyAuthorization,
  type AuthorizationRequest,
  type ConsentDescribeResult,
} from "./actions";

/**
 * The consent screen.
 *
 * It is not an auto-approving redirect, and that is the whole point: this is
 * the only moment a human is in the loop, so it has to be a moment. It names
 * the client, shows the exact URI the credential will be delivered to, lists
 * what the client will be able to read in plain language, and requires an
 * explicit action.
 *
 * The redirect URI is on the screen because it is the one thing that decides
 * where a credential ends up. A screen that shows "Claude wants access" and
 * hides the destination cannot be used to notice that "Claude" is delivering to
 * somebody else's callback.
 */
/**
 * How long the approval screen is held before handing the browser back.
 *
 * Without a pause the redirect fires within a frame and the confirmation is
 * never seen — the user goes from "Approve" to their app with no acknowledgement
 * that anything happened, which is exactly when people wonder whether it
 * worked. A beat and a half is long enough to read "Access approved" and short
 * enough that nobody experiences it as latency.
 *
 * The code is already issued by this point, so the wait costs nothing but the
 * wait itself. Cancelling gets a shorter one: there is less to read, and
 * lingering on a refusal is just friction.
 */
const HANDOFF_PAUSE_MS = { approve: 1500, deny: 700 };

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
  // Set once the decision is made and we are handing the browser back to the
  // client. See the handoff state below for why this is a screen and not just
  // a redirect.
  const [handoff, setHandoff] = useState<null | {
    decision: "approve" | "deny";
    url: string;
  }>(null);

  // A refused request never reaches the decision UI. There is nothing for a
  // human to decide about a request the authorization server will not honour,
  // and rendering an Approve button over one would teach people to click
  // through errors.
  if (!described.ok) {
    return (
      <Shell>
        <Card className="w-full shadow-lg">
          <CardHeader className="space-y-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-full bg-destructive/10">
              <AlertTriangle className="h-5 w-5 text-destructive" />
            </div>
            <CardTitle className="text-2xl tracking-tight">
              This request can&rsquo;t be completed
            </CardTitle>
            <CardDescription className="text-base">
              {described.description}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="font-mono text-xs text-muted-foreground">
              {described.error}
            </p>
            <p className="text-sm text-muted-foreground">
              Nothing has been shared. You can close this window and try
              connecting again from the application.
            </p>
          </CardContent>
        </Card>
      </Shell>
    );
  }

  const { details } = described;
  const clientLabel = details.clientName || details.clientId;

  // THE HANDOFF. Approving used to set window.location and hope.
  //
  // The destination is almost always a loopback listener the client opened on
  // the user's own machine, and if that listener is gone — the app crashed, the
  // user closed it, the flow sat too long — the browser lands on a raw
  // connection error with no explanation and no way back. From our origin we
  // cannot detect that: it is a cross-origin navigation.
  //
  // So we say what is happening, trigger the navigation, and leave a manual
  // link and an explanation on screen behind it. If the redirect works the user
  // never reads this; if it does not, they are not stranded on a browser error
  // page wondering what went wrong.
  if (handoff) {
    const approved = handoff.decision === "approve";

    // APPROVAL GETS A MOMENT. Everything up to here has been careful and a
    // little stern — read this URI, only approve if you recognise it — which is
    // right for the decision and wrong for the instant after it. This is the
    // one screen in the flow that is allowed to be pleased with itself.
    //
    // Cancelling deliberately does NOT get the same treatment: celebrating a
    // refusal would read as sarcasm, and the thing that matters there is the
    // reassurance that nothing was shared.
    if (approved) {
      // Full-bleed and dark, not a card. The rest of the flow is deliberately
      // careful — read this URI, only approve if you recognise it — and a
      // celebration wearing the same chrome does not land. This is the one
      // screen that gets the whole viewport.
      //
      // Three lines and nothing else: the art, what happened, and the joke.
      // Everything functional is demoted to the footer, because the user's job
      // here is finished and the page is about to leave anyway.
      //
      // min-h-screen is correct here BECAUSE the OAuth routes drop the site
      // header and footer (see conditional-header.tsx). It was briefly wrong
      // when they did not: the section plus the chrome exceeded the viewport,
      // the page scrolled, and on a phone the flame was clipped out of sight
      // before anyone saw it. If chrome ever returns to these routes, this
      // needs to shrink again.
      return (
        <main className="flex min-h-screen flex-col items-center justify-center gap-7 bg-neutral-950 px-6 py-14 text-center sm:gap-8">
          <div className="relative">
            {/* A warm bloom behind the flame, so it lights the page rather
                than sitting on it. */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute left-1/2 top-1/2 h-[120%] w-[140%] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(ellipse_at_center,rgba(249,115,22,0.18),transparent_65%)]"
            />
            <AsciiFire className="relative text-[7px] leading-[1.05] xs:text-[8px] sm:text-[12px] md:text-[15px]" />
          </div>

          <div className="space-y-2">
            {/* The fire is aria-hidden, so the outcome is announced here. */}
            <p
              role="status"
              className="font-mono text-lg text-neutral-100 sm:text-xl"
            >
              successfully authenticated!
            </p>
            <p className="font-mono text-2xl font-bold tracking-tight text-amber-400 sm:text-3xl">
              Burn it all down.
            </p>
          </div>

          <div className="space-y-1 font-mono text-xs text-neutral-500">
            <p>Returning you to {clientLabel}&hellip;</p>
            {/* The safety net, demoted to a footnote rather than a panel. The
                destination is usually a loopback listener on this machine; if
                it is gone the browser lands on a connection error we cannot
                detect from here, so the way forward stays on screen. */}
            <p>
              Not redirected?{" "}
              <a
                href={handoff.url}
                className="text-amber-500/80 underline underline-offset-4 hover:text-amber-400"
              >
                Continue to {clientLabel}
              </a>
            </p>
          </div>
        </main>
      );
    }

    return (
      <Shell>
        <Card className="w-full shadow-lg">
          <CardHeader className="space-y-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-full bg-muted">
              <X className="h-5 w-5 text-muted-foreground" />
            </div>
            <CardTitle className="text-2xl tracking-tight">
              Request cancelled
            </CardTitle>
            <CardDescription className="text-base">
              Nothing was shared. Returning you to{" "}
              <span className="font-medium text-foreground">{clientLabel}</span>
              .
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Handing you back&hellip;</span>
            </div>
            <HandoffFallback url={handoff.url} clientLabel={clientLabel} />
          </CardContent>
        </Card>
      </Shell>
    );
  }

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
    // Show the handoff first, then navigate after a beat. A full navigation,
    // not a router
    // push: the destination belongs to the OAuth client (usually a loopback
    // listener on the user's own machine) and is not a route in this app.
    setHandoff({ decision, url: result.redirectTo });
    window.setTimeout(() => {
      window.location.href = result.redirectTo;
    }, HANDOFF_PAUSE_MS[decision]);
  }

  return (
    <Shell>
      <Card className="w-full shadow-lg">
        <CardHeader className="space-y-4">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            <Lock className="h-3.5 w-3.5" />
            <span>Authorise an application</span>
          </div>

          <div className="flex items-start gap-4">
            <div className="relative h-12 w-12 shrink-0">
              <Image
                src="/logo.png"
                alt="Shorted"
                fill
                className="object-contain"
                priority
              />
            </div>
            <div className="space-y-1.5">
              <CardTitle className="text-2xl leading-snug tracking-tight">
                <span className="break-words">{clientLabel}</span> wants to
                access your Shorted data
              </CardTitle>
              {userEmail ? (
                <CardDescription className="text-sm">
                  Signed in as{" "}
                  <span className="font-medium text-foreground">
                    {userEmail}
                  </span>
                </CardDescription>
              ) : null}
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-5">
          <section className="space-y-3 rounded-lg border p-4">
            <h2 className="text-sm font-semibold">It will be able to</h2>
            <ul className="space-y-2.5">
              {details.scopes.map((line) => (
                <li
                  key={line.scope}
                  className="flex items-start gap-2.5 text-sm"
                >
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                  <span>
                    {line.description}
                    <span className="ml-1.5 font-mono text-xs text-muted-foreground">
                      {line.scope}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">
              Read-only. It cannot change anything in your account, and this
              does not grant access to your billing or API keys.
            </p>
          </section>

          {/* Where the credential goes. Verbatim, unshortened, and never a
              link — a clickable destination on a consent screen is a phishing
              surface. */}
          <section className="space-y-2 rounded-lg border p-4">
            <h2 className="text-sm font-semibold">
              Access will be delivered to
            </h2>
            <p className="break-all rounded bg-muted/50 px-2.5 py-2 font-mono text-xs">
              {details.redirectUri}
            </p>
            <p className="text-xs text-muted-foreground">
              Only approve if you recognise this address as belonging to the
              application you are connecting.
            </p>
          </section>

          {failure ? (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{failure}</span>
            </p>
          ) : null}

          <div className="flex flex-col gap-2 pt-1 sm:flex-row-reverse">
            <Button
              onClick={() => void decide("approve")}
              disabled={pending !== null}
              className="h-11 text-base font-medium sm:flex-1"
            >
              {pending === "approve" ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Authorising&hellip;
                </>
              ) : (
                "Approve"
              )}
            </Button>
            <Button
              variant="outline"
              onClick={() => void decide("deny")}
              disabled={pending !== null}
              className="h-11 text-base font-medium sm:flex-1"
            >
              {pending === "deny" ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Cancelling&hellip;
                </>
              ) : (
                "Cancel"
              )}
            </Button>
          </div>
        </CardContent>
      </Card>
    </Shell>
  );
}

/**
 * The escape hatch behind the redirect, shared by both decisions.
 *
 * The destination is almost always a loopback listener on the user's own
 * machine. If it is gone the browser lands on a raw connection error we cannot
 * detect from here, so the link and the explanation sit behind the redirect: if
 * it works nobody reads this, and if it does not, nobody is stranded.
 */
function HandoffFallback({
  url,
  clientLabel,
}: {
  url: string;
  clientLabel: string;
}) {
  return (
    <div className="space-y-2 rounded-lg border bg-muted/30 p-4">
      <p className="text-sm font-medium">Still here after a few seconds?</p>
      <p className="text-sm text-muted-foreground">
        The application needs to be running to receive this. Make sure it is
        still open, then use the link below.
      </p>
      {/* A real link, not a button that re-runs the flow: the code has already
          been issued and is single-use. */}
      <a
        href={url}
        className="inline-block break-all font-mono text-xs text-primary underline underline-offset-4"
      >
        Continue to {clientLabel}
      </a>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-gradient-to-br from-background via-background to-muted/20 px-4 py-12">
      <div className="w-full max-w-lg">{children}</div>
    </main>
  );
}

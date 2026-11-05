"use client";

import { useSession } from "next-auth/react";
import { useEffect, useState } from "react";

import { Button } from "~/@/components/ui/button";
import { strategyCapabilityEnabled } from "~/@/lib/strategies/capabilities";
import {
  listSavedStrategies,
  saveStrategy,
  unsaveStrategy,
} from "~/app/actions/strategies/saved";

/** The copy shown when a save is refused at the cap (the API's limit is 20). */
const LIMIT_COPY =
  "You can save up to 20 strategies. Remove one to save another.";

/**
 * The Save control on a strategy page. It draws for a signed-in viewer only: the
 * capability registry decides whether the feature is on, and the session decides
 * whether the viewer may use it. Anonymous visitors and a session still loading
 * see nothing, so the static HTML is the same for everyone.
 *
 * It reads the viewer's list once on mount to know whether this strategy is saved,
 * and then toggles it. A failed toggle says so beside the control; the saved state
 * is never changed on the screen until the API has answered.
 */
export function SaveStrategyButton({
  strategyId,
  strategyName,
}: {
  strategyId: string;
  strategyName: string;
}) {
  if (!strategyCapabilityEnabled("saves")) return null;
  // The slot holds the control's height for every viewer, so the page does not
  // move when a signed-in viewer's list arrives after hydration (CLS).
  return (
    <div className="flex min-h-9 flex-col items-start gap-1" data-save-slot>
      <SaveControl strategyId={strategyId} strategyName={strategyName} />
    </div>
  );
}

type Message = "limit" | "failed" | null;

function SaveControl({
  strategyId,
  strategyName,
}: {
  strategyId: string;
  strategyName: string;
}) {
  const { data: session, status } = useSession();
  const signedIn = status === "authenticated" && !!session?.user?.id;
  // null until the viewer's list has been read: the control draws nothing before then.
  const [saved, setSaved] = useState<boolean | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<Message>(null);

  useEffect(() => {
    if (!signedIn) return;
    let live = true;
    // A rejected read leaves the control hidden: there is no state to show.
    listSavedStrategies()
      .then((result) => {
        if (!live || !result.ok) return;
        setSaved(result.strategies.some((s) => s.strategyRef === strategyId));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [signedIn, strategyId]);

  if (!signedIn || saved === null) return null;

  const toggle = async () => {
    setPending(true);
    setMessage(null);
    try {
      if (saved) {
        const result = await unsaveStrategy(strategyId);
        if (result.ok) setSaved(false);
        else setMessage("failed");
      } else {
        const result = await saveStrategy(strategyId);
        if (result.ok) setSaved(true);
        else setMessage(result.reason === "limit" ? "limit" : "failed");
      }
    } catch {
      // A rejected action (a network failure, or a deploy that retired the action)
      // must not leave the control disabled.
      setMessage("failed");
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        type="button"
        variant={saved ? "secondary" : "outline"}
        size="sm"
        aria-pressed={saved}
        disabled={pending}
        onClick={() => void toggle()}
      >
        {/* The accessible name starts with the visible label, so a speech user who says
            the label reaches the control (WCAG 2.5.3). The name is the label and the
            strategy; the pressed state carries the saved state. */}
        {saved ? "Saved" : "Save"}
        <span className="sr-only"> {strategyName}</span>
      </Button>
      {message === "limit" ? (
        <p role="status" className="text-xs text-muted-foreground">
          {LIMIT_COPY}
        </p>
      ) : message === "failed" ? (
        <p role="status" className="text-xs text-muted-foreground">
          Could not update your saved strategies. Try again.
        </p>
      ) : null}
    </div>
  );
}

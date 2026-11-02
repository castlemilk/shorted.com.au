"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import { useSession } from "next-auth/react";
import { Check, Loader2, Lock, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { eyebrow } from "@/lib/typography";
import {
  YELLOW_SIGN_IN_CLASS,
  YellowSignInButton,
} from "~/@/components/ui/intel-lock";
import type {
  ChartIndicatorDef,
  ChartIndicatorId,
  IndicatorAccess,
} from "./chart-indicators";

/**
 * How the menu offers sign-in: a link to /signin (the stock page), or a callback (the
 * Activity). A callback can be busy: its link is on its way out, so the button shows
 * that and takes no press until it is done.
 */
export type IndicatorSignIn =
  | { callbackUrl: string }
  | { onClick: () => void; busy?: boolean };

/**
 * Whether the advanced indicators are open to this visitor. `unlock: "never"` (the
 * Discord Activity, which cannot hold a session) is signed out whatever the
 * session says. The session is read on every render either way, so the hook order
 * does not depend on the option.
 */
export function useIndicatorAccess(unlock: "session" | "never"): IndicatorAccess {
  const { status } = useSession();
  if (unlock === "never") return "signed-out";
  if (status === "authenticated") return "signed-in";
  return status === "loading" ? "checking" : "signed-out";
}

export interface IndicatorMenu {
  open: boolean;
  toggle: () => void;
  /** Closes the menu; `returnFocus` puts the focus back on the trigger (Escape does, a press outside does not). */
  close: (returnFocus: boolean) => void;
  triggerRef: RefObject<HTMLButtonElement>;
  id: string;
}

/**
 * The open state of the Indicators menu. It is a disclosure (a button that shows a
 * group), not a menu, so the arrow keys do not rove across it.
 */
export function useIndicatorMenu(): IndicatorMenu {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const id = useId();
  const toggle = useCallback(() => setOpen((was) => !was), []);
  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus({ preventScroll: true });
  }, []);
  return { open, toggle, close, triggerRef, id };
}

export interface IndicatorMenuPanelProps {
  id: string;
  /** The menu items for the view (menuIndicators). */
  items: readonly ChartIndicatorDef[];
  selected: readonly ChartIndicatorId[];
  onToggle: (id: ChartIndicatorId) => void;
  access: IndicatorAccess;
  signIn: IndicatorSignIn;
  onClose: (returnFocus: boolean) => void;
  triggerRef: RefObject<HTMLElement>;
  /** The chart is too short for a panel indicator: those items say so and do nothing. */
  panelUnavailable?: boolean;
  /** Selected indicators with nothing to draw on this series, for want of history: the item says so. */
  noHistory?: readonly ChartIndicatorId[];
  /** Where the menu sits. It is absolute inside the chart box, so the caller places it. */
  className?: string;
}

const NO_HISTORY: readonly ChartIndicatorId[] = Object.freeze([]);

/**
 * The menu itself: a panel of toggles over the chart. It is positioned with CSS,
 * not a portal or a floating-ui popover, because a landscape chart is rotated and
 * those position with the wrong maths inside it.
 */
export function IndicatorMenuPanel({
  id,
  items,
  selected,
  onToggle,
  access,
  signIn,
  onClose,
  triggerRef,
  panelUnavailable = false,
  noHistory = NO_HISTORY,
  className,
}: IndicatorMenuPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  // The keyboard starts inside the menu, on its first toggle.
  useEffect(() => {
    panelRef.current
      ?.querySelector<HTMLButtonElement>(
        "button[aria-pressed]:not([aria-disabled='true'])",
      )
      ?.focus({ preventScroll: true });
  }, []);

  // The menu answers to what happens in it and at its trigger, and to nothing else.
  // Escape is taken only when focus is in the menu or on the trigger: a dialog, a
  // pinned reading or a field elsewhere keeps its own Escape. A taken Escape is
  // preventDefault'ed, so the landscape box (which hears Escape on window, after
  // everything else) keeps its orientation. A press outside closes the menu, except
  // on the trigger, whose own click would otherwise close and reopen it in one
  // gesture. Focus moving to an element outside both closes it, without moving focus.
  useEffect(() => {
    const within = (node: EventTarget | null) =>
      node instanceof Node &&
      (panelRef.current?.contains(node) === true ||
        triggerRef.current?.contains(node) === true);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || !within(e.target)) return;
      e.preventDefault();
      onClose(true);
    };
    const onPointer = (e: PointerEvent) => {
      if (!within(e.target)) onClose(false);
    };
    // Focus that goes nowhere (relatedTarget null) is the pointer's business, not the
    // focus's: WebKit blurs a pressed button without focusing another element, so the
    // press on a toggle or a locked row would otherwise close the menu before its click
    // lands. onPointer has judged every press outside already. Only focus moving to an
    // element outside the menu and its trigger closes it.
    const onFocusOut = (e: FocusEvent) => {
      if (e.relatedTarget === null || within(e.relatedTarget)) return;
      onClose(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, [onClose, triggerRef]);

  const base = items.filter((def) => def.tier === "base");
  const advanced = items.filter((def) => def.tier === "advanced");

  return (
    <div
      id={id}
      ref={panelRef}
      role="group"
      aria-label="Chart indicators"
      // Focusable without a tab stop, so a press on content that cannot take focus (a
      // locked row, a heading, the gap between the columns) leaves the focus inside the
      // menu, and Escape still reaches it. The outline is the menu's, not a focus ring.
      tabIndex={-1}
      className={cn(
        "absolute z-30 max-h-[calc(100%-1rem)] w-[min(26rem,calc(100%-1rem))] overflow-y-auto rounded-md border bg-popover p-2 pr-8 text-popover-foreground outline-none",
        className,
      )}
    >
      <button
        type="button"
        onClick={() => onClose(true)}
        className="absolute right-1 top-1 inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/50 hover:text-foreground"
      >
        <X aria-hidden className="h-4 w-4" />
        <span className="sr-only">Close indicators</span>
      </button>
      <div className="grid grid-cols-2 gap-x-3">
        {base.length > 0 && (
          <div className="min-w-0">
            <p id={`${id}-base`} className={cn(eyebrow, "px-1")}>
              Indicators
            </p>
            <ul aria-labelledby={`${id}-base`} className="mt-1 grid gap-0.5">
              {base.map((def) => (
                <IndicatorToggle
                  key={def.id}
                  def={def}
                  on={selected.includes(def.id)}
                  unavailable={panelUnavailable && def.kind === "panel"}
                  noHistory={noHistory.includes(def.id)}
                  onToggle={onToggle}
                />
              ))}
            </ul>
          </div>
        )}
        {advanced.length > 0 && (
          <div className="min-w-0">
            <p id={`${id}-advanced`} className={cn(eyebrow, "px-1")}>
              Advanced
            </p>
            <ul aria-labelledby={`${id}-advanced`} className="mt-1 grid gap-0.5">
              {advanced.map((def) =>
                access === "signed-in" ? (
                  <IndicatorToggle
                    key={def.id}
                    def={def}
                    on={selected.includes(def.id)}
                    unavailable={panelUnavailable && def.kind === "panel"}
                    noHistory={noHistory.includes(def.id)}
                    onToggle={onToggle}
                  />
                ) : (
                  <LockedIndicator key={def.id} def={def} />
                ),
              )}
            </ul>
            <SignInOffer access={access} signIn={signIn} />
          </div>
        )}
      </div>
    </div>
  );
}

function Swatch({ def, locked = false }: { def: ChartIndicatorDef; locked?: boolean }) {
  const style: CSSProperties = {
    borderColor: def.color,
    borderTopStyle:
      def.dash === "2,3" ? "dotted" : def.dash ? "dashed" : "solid",
  };
  return (
    <span
      aria-hidden
      className={cn("w-4 shrink-0 border-t-2", locked && "opacity-50")}
      style={style}
    />
  );
}

function IndicatorToggle({
  def,
  on,
  unavailable,
  noHistory,
  onToggle,
}: {
  def: ChartIndicatorDef;
  on: boolean;
  unavailable: boolean;
  noHistory: boolean;
  onToggle: (id: ChartIndicatorId) => void;
}) {
  return (
    <li>
      <button
        type="button"
        aria-pressed={on}
        aria-disabled={unavailable || undefined}
        title={def.description}
        onClick={() => {
          if (!unavailable) onToggle(def.id);
        }}
        className={cn(
          "flex min-h-8 w-full items-center gap-2 rounded px-1 py-1 text-left text-xs transition-colors [@media(pointer:coarse)_and_(min-height:481px)]:min-h-10",
          on
            ? "text-foreground"
            : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
          unavailable && "cursor-not-allowed opacity-60",
        )}
      >
        <Swatch def={def} />
        <span className="min-w-0 flex-1">
          {def.label}
          {unavailable && (
            <span className="block text-[11px] text-muted-foreground">
              Needs a taller chart
            </span>
          )}
          {!unavailable && noHistory && (
            <span className="block text-[11px] text-muted-foreground">
              Not enough history
            </span>
          )}
        </span>
        {on && <Check aria-hidden className="h-3.5 w-3.5 shrink-0" />}
      </button>
    </li>
  );
}

function LockedIndicator({ def }: { def: ChartIndicatorDef }) {
  return (
    <li
      title={def.description}
      className="flex min-h-8 items-center gap-2 px-1 py-1 text-xs text-muted-foreground"
    >
      <Swatch def={def} locked />
      <span className="min-w-0 flex-1">{def.label}</span>
      <Lock aria-hidden className="h-3.5 w-3.5 shrink-0" />
      <span className="sr-only">, locked</span>
    </li>
  );
}

/**
 * The sign-in that is a callback (the Activity's, which opens outside Discord). While its
 * link is on its way out it shows that (`aria-busy`, a spinner) and takes no press.
 */
function SignInAction({
  onClick,
  busy,
}: {
  onClick: () => void;
  busy?: boolean;
}) {
  return (
    <>
      <button
        type="button"
        aria-busy={busy ? true : undefined}
        onClick={() => {
          if (!busy) onClick();
        }}
        className={cn(YELLOW_SIGN_IN_CLASS, "mt-2 h-9 w-full px-2 text-xs")}
      >
        {busy && <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />}
        Sign in on Shorted
      </button>
      <p className="mt-1 text-[11px] text-muted-foreground">
        Opens shorted.com.au in your browser.
      </p>
    </>
  );
}

function SignInOffer({
  access,
  signIn,
}: {
  access: IndicatorAccess;
  signIn: IndicatorSignIn;
}) {
  if (access === "checking") {
    return <p className="mt-2 text-xs text-muted-foreground">Checking sign-in…</p>;
  }
  if (access !== "signed-out") return null;
  return (
    <div>
      {"callbackUrl" in signIn ? (
        <YellowSignInButton
          callbackUrl={signIn.callbackUrl}
          className="mt-2 h-9 w-full px-2 text-xs"
        >
          Sign in to unlock
        </YellowSignInButton>
      ) : (
        <SignInAction onClick={signIn.onClick} busy={signIn.busy} />
      )}
      <p className="mt-1 text-[11px] text-muted-foreground">
        Free account · no card required
      </p>
    </div>
  );
}

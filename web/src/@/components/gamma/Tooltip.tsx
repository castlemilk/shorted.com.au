"use client";

import {
  cloneElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
} from "react";

export type TooltipPlacement = "auto" | "top" | "bottom" | "left" | "right";

export type TooltipProps = Omit<
  HTMLAttributes<HTMLSpanElement>,
  "content" | "children"
> & {
  /** Short description. Keep it to a phrase or one sentence. */
  content: ReactNode;
  /** A single focusable trigger, usually a button or link. */
  children: ReactElement<{ "aria-describedby"?: string }>;
  /** A preferred side. `auto` flips to the side with the most room. */
  placement?: TooltipPlacement;
  /** Hover delay before opening. Keyboard focus opens immediately. */
  delay?: number;
  /** Grace period before closing on pointer leave or blur. */
  closeDelay?: number;
  /** A quick handoff between triggers skips the opening delay. */
  warmDuration?: number;
  disabled?: boolean;
};

type ResolvedTooltip = {
  placement: Exclude<TooltipPlacement, "auto">;
  shiftX: number;
  shiftY: number;
  arrowX: number;
  arrowY: number;
};

const sides = ["top", "right", "bottom", "left"] as const;
let lastTooltipClosedAt = 0;

/**
 * A short anchored description. Pointer hover, keyboard focus, and touch all
 * reveal the same text; Escape closes it. The trigger keeps its own focus and
 * action behavior. Placement resolves against the viewport so the surface
 * flips or slides along the edge, and it adds itself to aria-describedby only
 * while visible.
 */
export function Tooltip({
  content,
  children,
  placement = "auto",
  delay = 220,
  closeDelay = 90,
  warmDuration = 600,
  disabled = false,
  className = "",
  ...props
}: TooltipProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [resolved, setResolved] = useState<ResolvedTooltip | null>(null);
  const rootRef = useRef<HTMLSpanElement>(null);
  const bubbleRef = useRef<HTMLSpanElement>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastClosedAt = useRef(0);

  function clearTimers() {
    if (openTimer.current) clearTimeout(openTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    openTimer.current = null;
    closeTimer.current = null;
  }

  function closeNow() {
    const now = Date.now();
    lastClosedAt.current = now;
    lastTooltipClosedAt = now;
    setOpen(false);
  }

  function scheduleOpen(immediate = false) {
    if (disabled) return;
    clearTimers();
    const warm =
      Date.now() - Math.max(lastClosedAt.current, lastTooltipClosedAt) <
      warmDuration;
    openTimer.current = setTimeout(
      () => setOpen(true),
      immediate || warm ? 0 : delay,
    );
  }

  function scheduleClose() {
    clearTimers();
    closeTimer.current = setTimeout(closeNow, closeDelay);
  }

  useEffect(() => () => clearTimers(), []);

  useLayoutEffect(() => {
    if (!open) return;
    const root = rootRef.current;
    const bubble = bubbleRef.current;
    if (!root || !bubble) return;

    function measure() {
      if (!root || !bubble) return;
      const rootRect = root.getBoundingClientRect();
      const bubbleWidth = bubble.offsetWidth;
      const bubbleHeight = bubble.offsetHeight;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const gap = 8;
      const margin = 8;
      const space = {
        top: rootRect.top - margin,
        right: viewportWidth - rootRect.right - margin,
        bottom: viewportHeight - rootRect.bottom - margin,
        left: rootRect.left - margin,
      };
      const fits = (side: (typeof sides)[number]) =>
        space[side] >=
        (side === "top" || side === "bottom"
          ? bubbleHeight + gap
          : bubbleWidth + gap);
      const preferred =
        placement !== "auto" && fits(placement) ? placement : null;
      const autoPreference = ["top", "bottom", "right", "left"] as const;
      const chosen =
        preferred ??
        autoPreference.find((side) => fits(side)) ??
        sides.reduce((best, side) => (space[side] > space[best] ? side : best));
      const horizontal = chosen === "top" || chosen === "bottom";
      let shiftX = 0;
      let shiftY = 0;
      let arrowX = bubbleWidth / 2;
      let arrowY = bubbleHeight / 2;

      if (horizontal) {
        const naturalLeft =
          rootRect.left + rootRect.width / 2 - bubbleWidth / 2;
        const left = Math.min(
          Math.max(naturalLeft, margin),
          Math.max(margin, viewportWidth - bubbleWidth - margin),
        );
        shiftX = left - naturalLeft;
        arrowX = Math.min(
          Math.max(rootRect.left + rootRect.width / 2 - left, 12),
          bubbleWidth - 12,
        );
      } else {
        const naturalTop =
          rootRect.top + rootRect.height / 2 - bubbleHeight / 2;
        const top = Math.min(
          Math.max(naturalTop, margin),
          Math.max(margin, viewportHeight - bubbleHeight - margin),
        );
        shiftY = top - naturalTop;
        arrowY = Math.min(
          Math.max(rootRect.top + rootRect.height / 2 - top, 12),
          bubbleHeight - 12,
        );
      }

      setResolved({ placement: chosen, shiftX, shiftY, arrowX, arrowY });
    }

    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open, placement]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (
        event.pointerType !== "mouse" &&
        event.target instanceof Node &&
        !rootRef.current?.contains(event.target)
      ) {
        closeNow();
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const describedBy = [
    children.props["aria-describedby"],
    open ? id : undefined,
  ]
    .filter(Boolean)
    .join(" ");
  const trigger = cloneElement(children, {
    "aria-describedby": describedBy || undefined,
  });
  const style = {
    "--tooltip-shift-x": `${resolved?.shiftX ?? 0}px`,
    "--tooltip-shift-y": `${resolved?.shiftY ?? 0}px`,
    "--tooltip-arrow-x": `${resolved?.arrowX ?? 0}px`,
    "--tooltip-arrow-y": `${resolved?.arrowY ?? 0}px`,
  } as CSSProperties;

  return (
    <span
      {...props}
      ref={rootRef}
      className={`tooltip ${className}`}
      onMouseEnter={() => scheduleOpen()}
      onMouseLeave={scheduleClose}
      onFocus={() => scheduleOpen(true)}
      onBlur={scheduleClose}
      onPointerDown={(event) => {
        if (event.pointerType === "mouse") return;
        clearTimers();
        if (open) {
          closeNow();
        } else {
          setOpen(true);
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          clearTimers();
          closeNow();
        }
      }}
    >
      {trigger}
      <span
        ref={bubbleRef}
        className="tooltip-bubble"
        id={id}
        role="tooltip"
        aria-hidden={!open}
        data-placement={
          resolved?.placement ?? (placement === "auto" ? "top" : placement)
        }
        data-visible={open}
        style={style}
      >
        {content}
      </span>
    </span>
  );
}

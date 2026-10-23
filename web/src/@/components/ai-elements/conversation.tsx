"use client";

import { ArrowDown } from "lucide-react";
import type { ComponentProps, RefObject } from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button } from "~/@/components/ui/button";
import { cn } from "~/@/lib/utils";

/** Within this many pixels of the end counts as the live edge. */
const LIVE_EDGE_PX = 48;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

interface StickToBottom {
  scrollerRef: RefObject<HTMLDivElement>;
  contentRef: RefObject<HTMLDivElement>;
  isAtBottom: boolean;
  onScroll: () => void;
  scrollToBottom: () => void;
}

const ConversationContext = createContext<StickToBottom | null>(null);

function useConversationContext(component: string): StickToBottom {
  const context = useContext(ConversationContext);
  if (!context) {
    throw new Error(`${component} must be rendered inside <Conversation>`);
  }
  return context;
}

/**
 * Keeps the newest content in view while the reader is at the live edge.
 *
 * The reader's intent is read from scroll direction, not from whether the
 * scroll was ours: scrolling up disengages, returning to the bottom re-engages.
 * Content that grows (a streaming reply) never fires a scroll event, so the
 * ResizeObserver on the content is what follows it down.
 */
function useStickToBottom(): StickToBottom {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const lastTopRef = useRef(0);
  const [isAtBottom, setIsAtBottom] = useState(true);

  const onScroll = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const distance =
      scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    const atBottom = distance <= LIVE_EDGE_PX;
    if (atBottom) {
      followRef.current = true;
    } else if (scroller.scrollTop < lastTopRef.current) {
      followRef.current = false;
    }
    lastTopRef.current = scroller.scrollTop;
    setIsAtBottom(atBottom);
  }, []);

  const scrollToBottom = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    followRef.current = true;
    if (typeof scroller.scrollTo === "function") {
      scroller.scrollTo({
        top: scroller.scrollHeight,
        behavior: prefersReducedMotion() ? "auto" : "smooth",
      });
    } else {
      scroller.scrollTop = scroller.scrollHeight;
    }
    setIsAtBottom(true);
  }, []);

  useEffect(() => {
    const scroller = scrollerRef.current;
    const content = contentRef.current;
    if (!scroller || !content) return;

    scroller.scrollTop = scroller.scrollHeight;
    lastTopRef.current = scroller.scrollTop;

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (!followRef.current) return;
      scroller.scrollTop = scroller.scrollHeight;
      lastTopRef.current = scroller.scrollTop;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  return { scrollerRef, contentRef, isAtBottom, onScroll, scrollToBottom };
}

export type ConversationProps = ComponentProps<"div">;

/** The region a thread lives in. It fills its parent and clips its own scroll. */
export function Conversation({ className, children, ...props }: ConversationProps) {
  const stick = useStickToBottom();
  return (
    <ConversationContext.Provider value={stick}>
      <div
        className={cn("relative flex min-h-0 flex-1 flex-col", className)}
        {...props}
      >
        {children}
      </div>
    </ConversationContext.Provider>
  );
}

/**
 * The scrolling message list. It is the live region: `aria-busy` (set while a
 * reply streams) holds screen-reader announcements until the reply is done,
 * instead of reading every token.
 */
export function ConversationContent({
  className,
  children,
  ...props
}: ComponentProps<"div">) {
  const { scrollerRef, contentRef, onScroll } = useConversationContext(
    "ConversationContent",
  );
  return (
    <div
      ref={scrollerRef}
      role="log"
      aria-live="polite"
      onScroll={onScroll}
      className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain"
      {...props}
    >
      <div
        ref={contentRef}
        className={cn("flex min-h-full flex-col gap-4", className)}
      >
        {children}
      </div>
    </div>
  );
}

/** Appears when the reader has scrolled away from the live edge. */
export function ConversationScrollButton({
  className,
  ...props
}: Omit<ComponentProps<typeof Button>, "onClick">) {
  const { isAtBottom, scrollToBottom } = useConversationContext(
    "ConversationScrollButton",
  );
  if (isAtBottom) return null;
  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      aria-label="Jump to latest message"
      onClick={scrollToBottom}
      className={cn(
        "absolute bottom-3 left-1/2 z-10 h-10 w-10 -translate-x-1/2 rounded-full bg-background shadow-md",
        className,
      )}
      {...props}
    >
      <ArrowDown className="h-4 w-4" />
    </Button>
  );
}

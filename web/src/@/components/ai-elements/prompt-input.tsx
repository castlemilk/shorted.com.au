"use client";

import { Send, Square } from "lucide-react";
import type { ComponentProps, KeyboardEvent } from "react";
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import { Button } from "~/@/components/ui/button";
import { Textarea } from "~/@/components/ui/textarea";
import { cn } from "~/@/lib/utils";

/** The chat request lifecycle, as useChat reports it. */
export type PromptInputStatus = "ready" | "submitted" | "streaming" | "error";

interface PromptInputContextValue {
  submit: () => void;
}

const PromptInputContext = createContext<PromptInputContextValue | null>(null);

export type PromptInputProps = Omit<ComponentProps<"form">, "onSubmit"> & {
  onSubmit: () => void;
};

/**
 * The composer form. Enter in the textarea and the submit button both call
 * `onSubmit`, through a ref so the context value never changes under a focused
 * textarea.
 */
export function PromptInput({ onSubmit, className, ...props }: PromptInputProps) {
  const submitRef = useRef(onSubmit);
  useLayoutEffect(() => {
    submitRef.current = onSubmit;
  });

  const context = useMemo<PromptInputContextValue>(
    () => ({ submit: () => submitRef.current() }),
    [],
  );

  return (
    <PromptInputContext.Provider value={context}>
      <form
        className={className}
        onSubmit={(event) => {
          event.preventDefault();
          submitRef.current();
        }}
        {...props}
      />
    </PromptInputContext.Provider>
  );
}

export type PromptInputTextareaProps = ComponentProps<typeof Textarea> & {
  /** Pixels; the box grows with its text up to this, then scrolls inside. */
  maxHeight?: number;
};

/**
 * Enter sends; Shift+Enter inserts a newline. Enter that confirms an IME
 * composition is not a send: `isComposing` (and keyCode 229, which Safari sends
 * for the same keystroke) mark it. The box grows with its text in JavaScript,
 * because `field-sizing: content` is not in Tailwind 3.
 */
export const PromptInputTextarea = forwardRef<
  HTMLTextAreaElement,
  PromptInputTextareaProps
>(({ className, onKeyDown, value, maxHeight = 160, ...props }, forwardedRef) => {
  const context = useContext(PromptInputContext);
  const innerRef = useRef<HTMLTextAreaElement | null>(null);

  const setRef = useCallback(
    (node: HTMLTextAreaElement | null) => {
      innerRef.current = node;
      if (typeof forwardedRef === "function") {
        forwardedRef(node);
      } else if (forwardedRef) {
        forwardedRef.current = node;
      }
    },
    [forwardedRef],
  );

  useLayoutEffect(() => {
    const element = innerRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, maxHeight)}px`;
    element.style.overflowY = element.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [value, maxHeight]);

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    if (event.key !== "Enter" || event.shiftKey) return;
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    context?.submit();
  };

  return (
    <Textarea
      ref={setRef}
      value={value}
      rows={1}
      onKeyDown={handleKeyDown}
      className={cn("min-h-[40px] resize-none", className)}
      {...props}
    />
  );
});
PromptInputTextarea.displayName = "PromptInputTextarea";

export type PromptInputFooterProps = ComponentProps<"div">;

/** The row under the textarea: a counter or hint on the left, the action on the right. */
export function PromptInputFooter({ className, ...props }: PromptInputFooterProps) {
  return (
    <div
      className={cn("flex items-center justify-between gap-2", className)}
      {...props}
    />
  );
}

export type PromptInputSubmitProps = Omit<
  ComponentProps<typeof Button>,
  "type" | "onClick"
> & {
  status?: PromptInputStatus;
  /** Called by Stop while a reply is being generated. */
  onStop?: () => void;
};

/**
 * Send while idle, Stop while the request is submitted or streaming. An errored
 * request shows Send again, so the person can retry from the composer.
 */
export function PromptInputSubmit({
  status = "ready",
  onStop,
  disabled,
  className,
  children,
  ...props
}: PromptInputSubmitProps) {
  if (status === "submitted" || status === "streaming") {
    return (
      <Button
        type="button"
        variant="destructive"
        size="icon"
        aria-label="Stop response"
        onClick={onStop}
        disabled={!onStop}
        className={cn("shrink-0", className)}
        {...props}
      >
        <Square className="h-4 w-4" />
      </Button>
    );
  }

  return (
    <Button
      type="submit"
      size="icon"
      aria-label="Send message"
      disabled={disabled}
      className={cn("shrink-0", className)}
      {...props}
    >
      {children ?? <Send className="h-4 w-4" />}
    </Button>
  );
}

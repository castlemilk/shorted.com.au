"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  PromptInput,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  type PromptInputStatus,
} from "~/@/components/ai-elements/prompt-input";
import { cn } from "~/@/lib/utils";

/** The longest question the API accepts. */
export const CHAT_MESSAGE_MAX_LENGTH = 2000;

/** From this length the counter shows, so the limit is never a surprise. */
const COUNTER_THRESHOLD = 1600;

/** Within this many characters of the limit the counter turns to a warning. */
const COUNTER_WARNING = 100;

interface ChatInputProps {
  onSend: (message: string) => void;
  onStop?: () => void;
  status: PromptInputStatus;
  /**
   * The thread is busy for a reason the request status does not cover, such as
   * a conversation still loading. Sending is held until it clears.
   */
  busy?: boolean;
  placeholder?: string;
}

export function ChatInput({
  onSend,
  onStop,
  status,
  busy = false,
  placeholder = "Ask about short positions, stocks, or market trends...",
}: ChatInputProps) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const wasGeneratingRef = useRef(false);
  const counterId = useId();

  const isGenerating = status === "submitted" || status === "streaming";
  const trimmed = value.trim();
  const canSend = trimmed.length > 0 && !isGenerating && !busy;
  const showCounter = value.length >= COUNTER_THRESHOLD;
  const remaining = CHAT_MESSAGE_MAX_LENGTH - value.length;

  const submit = useCallback(() => {
    if (!canSend) return;
    onSend(trimmed);
    setValue("");
    textareaRef.current?.focus();
  }, [canSend, onSend, trimmed]);

  // The textarea is disabled while a request is submitted, which drops focus.
  // Hand it back once the reply is done, unless the person has moved focus
  // somewhere on purpose.
  useEffect(() => {
    if (isGenerating) {
      wasGeneratingRef.current = true;
      return;
    }
    if (!wasGeneratingRef.current) return;
    wasGeneratingRef.current = false;
    const active = document.activeElement;
    if (!active || active === document.body) {
      textareaRef.current?.focus();
    }
  }, [isGenerating]);

  return (
    <PromptInput onSubmit={submit} className="flex flex-col gap-2 p-3">
      <PromptInputTextarea
        ref={textareaRef}
        value={value}
        onChange={(event) =>
          setValue(event.target.value.slice(0, CHAT_MESSAGE_MAX_LENGTH))
        }
        placeholder={placeholder}
        aria-label="Message Shorted AI"
        aria-describedby={showCounter ? counterId : undefined}
        maxLength={CHAT_MESSAGE_MAX_LENGTH}
        disabled={busy || status === "submitted"}
        className="text-sm"
      />
      <PromptInputFooter>
        {showCounter ? (
          <span
            id={counterId}
            className={cn(
              "text-xs tabular-nums",
              remaining <= COUNTER_WARNING
                ? "font-medium text-destructive"
                : "text-muted-foreground",
            )}
          >
            {value.length}/{CHAT_MESSAGE_MAX_LENGTH}
          </span>
        ) : (
          <span className="hidden text-[11px] text-muted-foreground sm:inline">
            Enter to send, Shift+Enter for a new line
          </span>
        )}
        <PromptInputSubmit
          status={status}
          onStop={onStop}
          disabled={!canSend}
        />
      </PromptInputFooter>
    </PromptInput>
  );
}

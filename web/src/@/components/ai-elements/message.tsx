"use client";

import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import type { ComponentProps, HTMLAttributes } from "react";
import { createContext, memo, useContext } from "react";
import { Streamdown } from "streamdown";
import { cn } from "~/@/lib/utils";

export type MessageRole = "user" | "assistant";

const MessageRoleContext = createContext<MessageRole>("assistant");

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: MessageRole;
};

/**
 * One turn in a conversation. `from` aligns it: the person's turns sit on the
 * trailing edge, the assistant's on the leading edge.
 */
export const Message = ({ className, from, ...props }: MessageProps) => (
  <MessageRoleContext.Provider value={from}>
    <div
      data-role={from}
      className={cn(
        "flex w-full min-w-0 gap-3",
        from === "user" ? "flex-row-reverse" : "flex-row",
        className,
      )}
      {...props}
    />
  </MessageRoleContext.Provider>
);

/** The column a turn's bubble and its attachments stack in. */
export const MessageContent = ({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) => {
  const from = useContext(MessageRoleContext);
  return (
    <div
      className={cn(
        "flex min-w-0 max-w-[85%] flex-col gap-2",
        from === "user" ? "items-end" : "items-start",
        className,
      )}
      {...props}
    />
  );
};

export type MessageResponseProps = ComponentProps<typeof Streamdown>;

const streamdownPlugins = { cjk, code, math, mermaid };

export const MessageResponse = memo(
  ({ className, ...props }: MessageResponseProps) => (
    <Streamdown
      className={cn(
        "size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        className,
      )}
      plugins={streamdownPlugins}
      {...props}
    />
  ),
  (prevProps, nextProps) =>
    prevProps.children === nextProps.children &&
    nextProps.isAnimating === prevProps.isAnimating,
);

MessageResponse.displayName = "MessageResponse";

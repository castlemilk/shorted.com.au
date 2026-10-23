"use client";

import type { HTMLAttributes } from "react";
import { createContext, useContext } from "react";
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

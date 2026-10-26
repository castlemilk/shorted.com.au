"use client";

import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import type { ComponentProps } from "react";
import { memo } from "react";
import { Streamdown } from "streamdown";
import { cn } from "~/@/lib/utils";
import { MessageImage } from "./message-image";

export type MessageResponseProps = ComponentProps<typeof Streamdown>;

const streamdownPlugins = { cjk, code, math, mermaid };

// Streamdown types the img slot for two prop shapes at once, and MessageImage
// reads src and alt by name, so it is typed loosely and cast to the slot here.
const imageOverride = MessageImage as unknown as NonNullable<
  MessageResponseProps["components"]
>["img"];

/**
 * Markdown for an assistant turn, rendered by Streamdown so partial markdown
 * while a reply streams stays well formed. It lives apart from `message.tsx`
 * because the Streamdown packages are ESM-only: the layout components must
 * load in plain module graphs (tests, server-rendered shells) without them.
 */
export const MessageResponse = memo(
  ({ className, ...props }: MessageResponseProps) => (
    <Streamdown
      className={cn(
        "size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        className,
      )}
      plugins={streamdownPlugins}
      {...props}
      // Last, so no caller can put back a fetching image: images are links, never
      // fetched (see MessageImage). Streamdown's defaults load any https image.
      components={{ img: imageOverride }}
    />
  ),
  (prevProps, nextProps) =>
    prevProps.children === nextProps.children &&
    nextProps.isAnimating === prevProps.isAnimating,
);

MessageResponse.displayName = "MessageResponse";

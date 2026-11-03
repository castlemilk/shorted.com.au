"use client";

import dynamic from "next/dynamic";

// The whole of /chat: client-only (Connect-RPC streams and the session hooks).
// Only the chat page reaches this module, so its chunk starts as the module runs
// in the browser, which is on /chat alone. The page is the chat, so it is above
// the fold.
if (typeof window !== "undefined") {
  void import("./chat-page-content");
}

export const ChatPageContent = dynamic(
  () => import("./chat-page-content").then((mod) => mod.ChatPageContent),
  { ssr: false },
);

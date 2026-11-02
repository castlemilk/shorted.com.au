"use client";

import dynamic from "next/dynamic";

// Client-only: it reads the chat through Connect-RPC. The root layout renders it
// on every route, so its chunk starts as this module runs in the browser (never
// on the server), as the root layout's first-load list did on every route.
if (typeof window !== "undefined") {
  void import("./chat-sidebar");
}

export const ChatSidebar = dynamic(
  () => import("./chat-sidebar").then((mod) => ({ default: mod.ChatSidebar })),
  { ssr: false },
);

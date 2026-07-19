"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { Button } from "~/@/components/ui/button";
import { MessageSquare, Lock, Loader2 } from "lucide-react";
import { useSubscription } from "~/@/hooks/use-subscription";
import { useSession } from "next-auth/react";

/**
 * Lightweight chat entry point rendered in the global layout on EVERY page.
 *
 * The real sidebar (`ChatSidebarFull`) drags in the whole chat stack —
 * `useChat` → @ai-sdk/react + `ai` + zod + connect-web, and (via the message
 * renderer) streamdown/KaTeX/shiki — several hundred KB that used to ship on
 * every page for a sheet that starts closed. This shell renders only a
 * look-alike trigger button; the first click swaps in the full component with
 * `initialOpen` so the sheet opens as soon as the chunk lands. After that the
 * full component stays mounted, so chat state persists across close/reopen
 * exactly as before the split.
 */
const ChatSidebarFull = dynamic(
  () => import("./chat-sidebar-full").then((m) => m.ChatSidebarFull),
  {
    ssr: false,
    loading: () => (
      <Button
        variant="outline"
        size="icon"
        className="fixed bottom-6 right-6 h-12 w-12 rounded-full shadow-lg z-50"
        aria-label="Opening Shorted AI chat"
        disabled
      >
        <Loader2 className="h-5 w-5 animate-spin" />
      </Button>
    ),
  }
);

interface ChatSidebarProps {
  stockCode?: string;
}

export function ChatSidebar({ stockCode }: ChatSidebarProps) {
  const [activated, setActivated] = useState(false);
  const { data: session } = useSession();
  const { isPremium } = useSubscription();
  const showChat = !!session && isPremium;

  // No chat for signed-out visitors at all — the floating trigger used to
  // open an upgrade prompt, but for the anonymous majority it's just UI
  // noise (and one more interactive element in every audit). The premium
  // gate inside ChatSidebarFull still handles signed-in-but-free users.
  if (!session) return null;

  if (activated) {
    return <ChatSidebarFull stockCode={stockCode} initialOpen />;
  }

  return (
    <Button
      variant="outline"
      size="icon"
      className="fixed bottom-6 right-6 h-12 w-12 rounded-full shadow-lg z-50"
      aria-label={
        showChat ? "Open Shorted AI chat" : "Open AI chat upgrade prompt"
      }
      onClick={() => setActivated(true)}
    >
      <MessageSquare className="h-5 w-5" />
      {!showChat && (
        <Lock className="absolute -bottom-0.5 -right-0.5 h-4 w-4 text-muted-foreground bg-background rounded-full p-0.5" />
      )}
    </Button>
  );
}

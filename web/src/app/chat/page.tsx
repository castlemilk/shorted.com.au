import type { Metadata } from "next";
import dynamic from "next/dynamic";

const ChatPageContent = dynamic(
  () => import("./chat-page-content").then((mod) => mod.ChatPageContent),
  { ssr: false },
);

export const metadata: Metadata = {
  title: "AI Chat | Shorted",
  description:
    "Chat with Shorted AI to get insights about short positions, stocks, market trends, and more.",
  robots: { index: false, follow: false },
};

export default function ChatPage() {
  return <ChatPageContent />;
}

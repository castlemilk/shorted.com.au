import type { Metadata } from "next";
import { ChatPageContent } from "./chat-page-content-loader";

export const metadata: Metadata = {
  title: "AI Chat",
  description:
    "Chat with Shorted AI to get insights about short positions, stocks, market trends, and more.",
  robots: { index: false, follow: false },
};

export default function ChatPage() {
  return <ChatPageContent />;
}

import { notFound } from "next/navigation";
import { ChatRenderSmokeClient } from "./chat-render-smoke-client";

export const dynamic = "force-dynamic";

export default function ChatRenderSmokePage() {
  const enabled =
    process.env.NODE_ENV !== "production" ||
    process.env.E2E_TEST === "1";
  if (!enabled) {
    notFound();
  }

  return <ChatRenderSmokeClient />;
}

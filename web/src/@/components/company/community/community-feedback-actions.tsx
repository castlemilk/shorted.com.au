"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { Button } from "~/@/components/ui/button";

interface CommunityFeedbackActionsProps {
  stockCode: string;
  targetType: "thread" | "comment" | "pulse" | "pulse_reply";
  targetId: string;
  initialScore: number;
}

export function CommunityFeedbackActions({
  stockCode,
  targetType,
  targetId,
  initialScore,
}: CommunityFeedbackActionsProps) {
  const { data: session } = useSession();
  const [score, setScore] = useState(initialScore);
  const [hasReported, setHasReported] = useState(false);

  async function handleUpvote() {
    if (!session?.user?.id) {
      return;
    }

    const response = await fetch("/api/community/votes", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        stockCode,
        targetType,
        targetId,
        value: 1,
      }),
    });

    if (response.ok) {
      setScore((current) => current + 1);
    }
  }

  async function handleReport() {
    if (!session?.user?.id || hasReported) {
      return;
    }

    const response = await fetch("/api/community/reports", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        stockCode,
        targetType,
        targetId,
        reason: "user_report",
      }),
    });

    if (response.ok) {
      setHasReported(true);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={handleUpvote}
        disabled={!session?.user?.id}
      >
        Upvote {score}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={handleReport}
        disabled={!session?.user?.id || hasReported}
      >
        {hasReported ? "Reported" : "Report"}
      </Button>
    </div>
  );
}

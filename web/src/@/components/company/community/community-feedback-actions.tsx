"use client";

import { useRef, useState } from "react";
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
  const [voteStatus, setVoteStatus] = useState<"idle" | "pending" | "voted">(
    "idle",
  );
  const [hasReported, setHasReported] = useState(false);
  const [isReporting, setIsReporting] = useState(false);
  const voteLockedRef = useRef(false);
  const reportLockedRef = useRef(false);

  async function handleUpvote() {
    if (!session?.user?.id || voteLockedRef.current) {
      return;
    }

    voteLockedRef.current = true;
    setVoteStatus("pending");

    try {
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
        setVoteStatus("voted");
        return;
      }
    } catch {
      // Keep the control retryable when the write fails.
    }

    voteLockedRef.current = false;
    setVoteStatus("idle");
  }

  async function handleReport() {
    if (!session?.user?.id || hasReported || reportLockedRef.current) {
      return;
    }

    reportLockedRef.current = true;
    setIsReporting(true);

    try {
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
        return;
      }
    } catch {
      // Keep the control retryable when the write fails.
    } finally {
      setIsReporting(false);
    }

    reportLockedRef.current = false;
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={handleUpvote}
        disabled={!session?.user?.id || voteStatus !== "idle"}
      >
        {voteStatus === "pending"
          ? "Voting..."
          : voteStatus === "voted"
            ? `Upvoted ${score}`
            : `Upvote ${score}`}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={handleReport}
        disabled={!session?.user?.id || hasReported || isReporting}
      >
        {hasReported ? "Reported" : isReporting ? "Reporting..." : "Report"}
      </Button>
    </div>
  );
}

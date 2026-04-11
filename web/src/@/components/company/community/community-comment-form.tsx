"use client";

import { startTransition, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "~/@/components/ui/button";
import { Textarea } from "~/@/components/ui/textarea";
import { type CommunityComment } from "~/@/types/community";

interface CommunityCommentFormProps {
  stockCode: string;
  threadId: string;
  onCreated: (comment: CommunityComment) => void;
}

export function CommunityCommentForm({
  stockCode,
  threadId,
  onCreated,
}: CommunityCommentFormProps) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);

    try {
      const response = await fetch(
        `/api/community/${stockCode}/threads/${threadId}/comments`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ body }),
        },
      );

      if (!response.ok) {
        throw new Error("Failed to create comment");
      }

      const data = (await response.json()) as { comment: CommunityComment };
      onCreated(data.comment);
      setBody("");
      startTransition(() => router.refresh());
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="grid gap-3 rounded-xl border border-border/70 bg-card/90 p-4 shadow-sm"
    >
      <div className="grid gap-1.5">
        <label htmlFor="community-comment-body" className="text-sm font-medium">
          Comment body
        </label>
        <Textarea
          id="community-comment-body"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          rows={3}
        />
      </div>
      <div className="flex justify-end">
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Posting..." : "Post comment"}
        </Button>
      </div>
    </form>
  );
}

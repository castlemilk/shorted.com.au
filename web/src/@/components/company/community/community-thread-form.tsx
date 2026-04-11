"use client";

import { startTransition, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "~/@/components/ui/button";
import { Input } from "~/@/components/ui/input";
import { Textarea } from "~/@/components/ui/textarea";
import { type CommunityThread } from "~/@/types/community";

interface CommunityThreadFormProps {
  stockCode: string;
  onCreated: (thread: CommunityThread) => void;
}

export function CommunityThreadForm({
  stockCode,
  onCreated,
}: CommunityThreadFormProps) {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [type, setType] = useState<CommunityThread["type"]>("bull");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);

    try {
      const response = await fetch(`/api/community/${stockCode}/threads`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type,
          title,
          body,
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to create thread");
      }

      const data = (await response.json()) as { thread: CommunityThread };
      onCreated(data.thread);
      setTitle("");
      setBody("");
      setType("bull");
      setIsOpen(false);
      startTransition(() => router.refresh());
    } finally {
      setIsSubmitting(false);
    }
  }

  if (!isOpen) {
    return (
      <Button variant="outline" onClick={() => setIsOpen(true)}>
        Start a thread
      </Button>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="grid gap-3 rounded-xl border border-border/70 bg-card/90 p-4 shadow-sm"
    >
      <div className="grid gap-1.5">
        <label htmlFor="community-thread-type" className="text-sm font-medium">
          Thread type
        </label>
        <select
          id="community-thread-type"
          value={type}
          onChange={(event) =>
            setType(event.target.value as CommunityThread["type"])
          }
          className="h-10 rounded-md border border-input bg-background px-3 text-sm"
        >
          <option value="bull">Bull</option>
          <option value="bear">Bear</option>
          <option value="catalyst">Catalyst</option>
          <option value="question">Question</option>
          <option value="news_reaction">News reaction</option>
        </select>
      </div>

      <div className="grid gap-1.5">
        <label htmlFor="community-thread-title" className="text-sm font-medium">
          Thread title
        </label>
        <Input
          id="community-thread-title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      </div>

      <div className="grid gap-1.5">
        <label htmlFor="community-thread-body" className="text-sm font-medium">
          Thread body
        </label>
        <Textarea
          id="community-thread-body"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          rows={4}
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Posting..." : "Post thread"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => setIsOpen(false)}
          disabled={isSubmitting}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

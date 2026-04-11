"use client";

import { startTransition, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "~/@/components/ui/button";
import { Textarea } from "~/@/components/ui/textarea";
import { type CommunityPulseItem } from "~/@/types/community";

interface CommunityPulseFormProps {
  stockCode: string;
  onCreated: (pulseItem: CommunityPulseItem) => void;
}

export function CommunityPulseForm({
  stockCode,
  onCreated,
}: CommunityPulseFormProps) {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [body, setBody] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);

    try {
      const response = await fetch(`/api/community/${stockCode}/pulse`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ body }),
      });

      if (!response.ok) {
        throw new Error("Failed to create pulse item");
      }

      const data = (await response.json()) as { pulse: CommunityPulseItem };
      onCreated(data.pulse);
      setBody("");
      setIsOpen(false);
      startTransition(() => router.refresh());
    } finally {
      setIsSubmitting(false);
    }
  }

  if (!isOpen) {
    return (
      <Button variant="outline" onClick={() => setIsOpen(true)}>
        Drop a pulse
      </Button>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="grid gap-3 rounded-xl border border-border/70 bg-card/90 p-4 shadow-sm"
    >
      <div className="grid gap-1.5">
        <label htmlFor="community-pulse-body" className="text-sm font-medium">
          Pulse update
        </label>
        <Textarea
          id="community-pulse-body"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          rows={3}
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Posting..." : "Post pulse"}
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

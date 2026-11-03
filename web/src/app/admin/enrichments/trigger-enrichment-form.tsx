"use client";

import { useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAsyncErrorHandler } from "@/hooks/use-async-error";

interface TriggerEnrichmentFormProps {
  /** Queues the enrichment job for the submitted stock code. */
  onTrigger: (formData: FormData) => Promise<unknown>;
}

/**
 * The admin "Trigger Enrichment" form.
 *
 * It submits through onSubmit rather than <form action>. React 19 clears a
 * form once its action succeeds, which would drop the stock code and the force
 * flag the admin typed (React 18 kept them). The button is disabled while the
 * job is queued, so the kept values cannot be submitted twice by accident. A
 * failed trigger still reaches the nearest error boundary, because
 * useAsyncErrorHandler rethrows it into render.
 */
export function TriggerEnrichmentForm({ onTrigger }: TriggerEnrichmentFormProps) {
  const runTrigger = useAsyncErrorHandler();
  const [isPending, startTransition] = useTransition();

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        const formData = new FormData(event.currentTarget);
        startTransition(async () => {
          await runTrigger(() => onTrigger(formData));
        });
      }}
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor="stockCode" className="text-xs">
          Stock Code
        </Label>
        <Input
          id="stockCode"
          name="stockCode"
          placeholder="e.g., CBA, BHP"
          className="h-9 text-sm"
          required
          pattern="[A-Z0-9]{3,4}"
          title="3-4 uppercase letters/numbers"
        />
      </div>
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          id="force"
          name="force"
          value="true"
          className="h-4 w-4 rounded border-input"
        />
        <Label htmlFor="force" className="text-xs cursor-pointer">
          Force re-enrichment (even if already enriched)
        </Label>
      </div>
      <Button
        type="submit"
        size="sm"
        className="w-full"
        disabled={isPending}
      >
        Trigger Enrichment
      </Button>
    </form>
  );
}

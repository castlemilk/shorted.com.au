"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAsyncErrorHandler } from "@/hooks/use-async-error";

/** The API's answer to a trigger, as triggerEnrichmentAction returns it. */
export interface TriggerEnrichmentResult {
  /** The job the API reports for this stock: a new one when `created`, otherwise an earlier one or "". */
  jobId: string;
  /** The API's status text. It is shown as it is when no new job was created. */
  message: string;
  /** True only when the API created a new job. */
  created: boolean;
}

interface TriggerEnrichmentFormProps {
  /** Queues the enrichment for the submitted stock code and returns the API's answer. */
  onTrigger: (formData: FormData) => Promise<TriggerEnrichmentResult>;
}

/**
 * The admin "Trigger Enrichment" form.
 *
 * It clears the stock code and the Force box only when the API created a job,
 * and then says what it queued. The clear is on purpose: a Force box left ticked
 * turns the admin's next code into a forced re-enrichment, a paid GPT run. The
 * code is cleared only while it still holds the code that was queued, so a code
 * typed during the run is kept.
 *
 * An answer that created no job keeps the fields as typed and shows the API's
 * message. The admin still has to act on it: a pending review blocks the run, or
 * a job for the stock is already running and only Force overrides it.
 *
 * It submits through onSubmit rather than <form action>. React 19 resets an
 * uncontrolled form once its action completes without throwing, whatever the
 * action answered, so a form action would clear the code on the answers that
 * created no job. A failed trigger reaches the root error boundary
 * (app/error.tsx), which replaces the page, so what was typed is lost on failure
 * whichever way the form submits. The button is disabled while the run is
 * pending, so a second press cannot start a second run.
 */
export function TriggerEnrichmentForm({ onTrigger }: TriggerEnrichmentFormProps) {
  const runTrigger = useAsyncErrorHandler();
  const [isPending, startTransition] = useTransition();
  const [status, setStatus] = useState("");

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        // currentTarget is null once this handler returns, so keep the form now.
        const form = event.currentTarget;
        const formData = new FormData(form);
        const code = String(formData.get("stockCode") ?? "");
        const forced = formData.get("force") === "true";
        setStatus("");
        startTransition(async () => {
          const answer = await runTrigger(() => onTrigger(formData));
          // null: the trigger failed, and the error has gone to the boundary.
          if (!answer) return;
          if (!answer.created) {
            setStatus(answer.message);
            return;
          }
          // The Force box always goes, so a ticked box cannot carry into the next run.
          const codeField = form.elements.namedItem("stockCode");
          if (codeField instanceof HTMLInputElement && codeField.value === code) {
            codeField.value = "";
          }
          const forceField = form.elements.namedItem("force");
          if (forceField instanceof HTMLInputElement) {
            forceField.checked = false;
          }
          setStatus(
            forced ? `Queued ${code} (forced re-enrichment).` : `Queued ${code}.`,
          );
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
      {/* Always mounted, so a screen reader announces the change to it. */}
      <p role="status" className="min-h-[1rem] text-xs text-muted-foreground">
        {status}
      </p>
    </form>
  );
}

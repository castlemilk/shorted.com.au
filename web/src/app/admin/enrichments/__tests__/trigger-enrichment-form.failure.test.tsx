import { act, fireEvent, render, screen } from "@testing-library/react";
import { TriggerEnrichmentForm } from "../trigger-enrichment-form";

// The real hook hands a failed trigger to the error boundary, and the boundary
// unmounts the form (see trigger-enrichment-form.test.tsx). This stand-in
// resolves to null instead, so the form stays mounted and the form's own rule
// is what gets tested: it clears only after the API creates a job.
jest.mock("@/hooks/use-async-error", () => ({
  useAsyncErrorHandler: () => async (operation: () => Promise<unknown>) => {
    try {
      return await operation();
    } catch {
      return null;
    }
  },
}));

const triggerButton = () =>
  screen.getByRole("button", { name: "Trigger Enrichment" });
const codeInput = () => screen.getByLabelText("Stock Code") as HTMLInputElement;
const forceBox = () =>
  screen.getByLabelText(/Force re-enrichment/) as HTMLInputElement;

/** Lets a resolved or rejected trigger settle inside act. */
const flush = () =>
  act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

describe("TriggerEnrichmentForm when a trigger fails and the form stays mounted", () => {
  it("keeps what the admin typed and announces nothing", async () => {
    const onTrigger = jest.fn(async (_formData: FormData) => {
      throw new Error("Failed to trigger enrichment: upstream unavailable");
    });
    render(<TriggerEnrichmentForm onTrigger={onTrigger} />);

    fireEvent.change(codeInput(), { target: { value: "CBA" } });
    fireEvent.click(forceBox());
    fireEvent.click(triggerButton());
    await flush();

    expect(onTrigger).toHaveBeenCalledTimes(1);
    expect(codeInput().value).toBe("CBA");
    expect(forceBox().checked).toBe(true);
    expect(screen.getByRole("status").textContent).toBe("");
    expect(triggerButton()).toBeEnabled();
  });

  it("clears an earlier announcement when the next trigger fails, and keeps the new input", async () => {
    let calls = 0;
    const onTrigger = jest.fn(async (_formData: FormData) => {
      calls += 1;
      if (calls === 1) {
        return {
          jobId: "job-1",
          message: "Enrichment job created. Job ID: job-1",
          created: true,
        };
      }
      throw new Error("Failed to trigger enrichment: upstream unavailable");
    });
    render(<TriggerEnrichmentForm onTrigger={onTrigger} />);

    fireEvent.change(codeInput(), { target: { value: "CBA" } });
    fireEvent.click(triggerButton());
    await flush();
    expect(screen.getByRole("status")).toHaveTextContent(/^Queued CBA\.$/);

    fireEvent.change(codeInput(), { target: { value: "BHP" } });
    fireEvent.click(forceBox());
    fireEvent.click(triggerButton());
    await flush();

    expect(onTrigger).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("status").textContent).toBe("");
    expect(codeInput().value).toBe("BHP");
    expect(forceBox().checked).toBe(true);
  });
});

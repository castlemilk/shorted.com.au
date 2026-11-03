import { Component, type ReactNode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import {
  TriggerEnrichmentForm,
  type TriggerEnrichmentResult,
} from "../trigger-enrichment-form";

/** Stands in for the segment's error boundary: it shows the error it catches. */
class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    return this.state.error ? (
      <p role="alert">{this.state.error.message}</p>
    ) : (
      this.props.children
    );
  }
}

const triggerButton = () =>
  screen.getByRole("button", { name: "Trigger Enrichment" });
const codeInput = () => screen.getByLabelText("Stock Code") as HTMLInputElement;
const forceBox = () =>
  screen.getByLabelText(/Force re-enrichment/) as HTMLInputElement;
const statusLine = () => screen.getByRole("status");

/** Lets a resolved or rejected trigger settle inside act. */
const flush = () =>
  act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

/** The answer the API gives when it creates a job, as triggerEnrichmentAction returns it. */
const createdJob = (jobId: string): TriggerEnrichmentResult => ({
  jobId,
  message: `Enrichment job created. Job ID: ${jobId}`,
  created: true,
});

/** The two answers that create no job (services/shorts/internal/services/shorts/enrichment.go). */
const PENDING_REVIEW_MESSAGE =
  "Pending enrichment already exists for CBA (Enrichment ID: en-7). Review or reject it first, or use force=true to create a new enrichment.";
const pendingReview: TriggerEnrichmentResult = {
  jobId: "",
  message: PENDING_REVIEW_MESSAGE,
  created: false,
};
const ALREADY_RUNNING_MESSAGE =
  "Enrichment already in progress for CBA (Job ID: job-9). Use force=true to override.";
const alreadyRunning: TriggerEnrichmentResult = {
  jobId: "job-9",
  message: ALREADY_RUNNING_MESSAGE,
  created: false,
};

describe("TriggerEnrichmentForm", () => {
  it("submits the stock code and the force flag", async () => {
    const onTrigger = jest.fn(async (_formData: FormData) =>
      createdJob("job-1"),
    );
    render(<TriggerEnrichmentForm onTrigger={onTrigger} />);

    fireEvent.change(screen.getByLabelText("Stock Code"), {
      target: { value: "CBA" },
    });
    fireEvent.click(screen.getByLabelText(/Force re-enrichment/));
    fireEvent.click(triggerButton());
    await flush();

    expect(onTrigger).toHaveBeenCalledTimes(1);
    const formData = onTrigger.mock.calls[0]?.[0];
    expect(formData?.get("stockCode")).toBe("CBA");
    expect(formData?.get("force")).toBe("true");
  });

  it("keeps the status line mounted and empty until the first success", () => {
    render(
      <TriggerEnrichmentForm
        onTrigger={jest.fn(async (_formData: FormData) => createdJob("job-1"))}
      />,
    );

    expect(statusLine().textContent).toBe("");
  });

  // Clears on purpose after a created job. A Force box left ticked turned the
  // admin's next code into a forced re-enrichment, a paid GPT run.
  it("clears the code and the Force box after a job is created, with Force", async () => {
    const onTrigger = jest.fn(async (_formData: FormData) =>
      createdJob("job-1"),
    );
    render(<TriggerEnrichmentForm onTrigger={onTrigger} />);

    fireEvent.change(codeInput(), { target: { value: "CBA" } });
    fireEvent.click(forceBox());
    fireEvent.click(triggerButton());
    await flush();

    expect(onTrigger).toHaveBeenCalledTimes(1);
    expect(codeInput().value).toBe("");
    expect(forceBox().checked).toBe(false);
    expect(statusLine()).toHaveTextContent(
      /^Queued CBA \(forced re-enrichment\)\.$/,
    );
  });

  it("clears the code after a job is created without Force, and says what it queued", async () => {
    const onTrigger = jest.fn(async (_formData: FormData) =>
      createdJob("job-1"),
    );
    render(<TriggerEnrichmentForm onTrigger={onTrigger} />);

    fireEvent.change(codeInput(), { target: { value: "CBA" } });
    fireEvent.click(triggerButton());
    await flush();

    expect(onTrigger).toHaveBeenCalledTimes(1);
    expect(codeInput().value).toBe("");
    expect(forceBox().checked).toBe(false);
    expect(statusLine()).toHaveTextContent(/^Queued CBA\.$/);
  });

  // A pending review or a running job answers with the API's own message, and
  // the admin's input stays, because they still have to act on it.
  it("keeps the code and shows the API's answer when a pending review blocks the run", async () => {
    const onTrigger = jest.fn(async (_formData: FormData) => pendingReview);
    render(<TriggerEnrichmentForm onTrigger={onTrigger} />);

    fireEvent.change(codeInput(), { target: { value: "CBA" } });
    fireEvent.click(triggerButton());
    await flush();

    expect(onTrigger).toHaveBeenCalledTimes(1);
    expect(codeInput().value).toBe("CBA");
    expect(statusLine().textContent).toBe(PENDING_REVIEW_MESSAGE);
  });

  it("keeps the code and shows the API's answer when a job for the stock is already running", async () => {
    const onTrigger = jest.fn(async (_formData: FormData) => alreadyRunning);
    render(<TriggerEnrichmentForm onTrigger={onTrigger} />);

    fireEvent.change(codeInput(), { target: { value: "CBA" } });
    fireEvent.click(triggerButton());
    await flush();

    expect(onTrigger).toHaveBeenCalledTimes(1);
    expect(codeInput().value).toBe("CBA");
    expect(statusLine().textContent).toBe(ALREADY_RUNNING_MESSAGE);
  });

  it("announces nothing and keeps the fields when no answer comes back", async () => {
    // A caller that resolves without an answer must not be read as a queued job.
    const onTrigger = jest.fn(
      async (_formData: FormData) =>
        undefined as unknown as TriggerEnrichmentResult,
    );
    render(<TriggerEnrichmentForm onTrigger={onTrigger} />);

    fireEvent.change(codeInput(), { target: { value: "CBA" } });
    fireEvent.click(triggerButton());
    await flush();

    expect(onTrigger).toHaveBeenCalledTimes(1);
    expect(codeInput().value).toBe("CBA");
    expect(statusLine().textContent).toBe("");
  });

  it("keeps a code typed while the run is pending, and clears a Force box ticked during it", async () => {
    let finish: (answer: TriggerEnrichmentResult) => void = () => undefined;
    const onTrigger = jest.fn(
      () =>
        new Promise<TriggerEnrichmentResult>((resolve) => {
          finish = resolve;
        }),
    );
    render(<TriggerEnrichmentForm onTrigger={onTrigger} />);

    fireEvent.change(codeInput(), { target: { value: "CBA" } });
    fireEvent.click(triggerButton());
    // The admin moves on while the run is pending.
    fireEvent.change(codeInput(), { target: { value: "BHP" } });
    fireEvent.click(forceBox());

    await act(async () => {
      finish(createdJob("job-1"));
    });

    expect(codeInput().value).toBe("BHP");
    expect(forceBox().checked).toBe(false);
    expect(statusLine()).toHaveTextContent(/^Queued CBA\.$/);
  });

  it("disables the button while the trigger is queued", async () => {
    let finish: () => void = () => undefined;
    const onTrigger = jest.fn(
      () =>
        new Promise<TriggerEnrichmentResult>((resolve) => {
          finish = () => resolve(createdJob("job-1"));
        }),
    );
    render(<TriggerEnrichmentForm onTrigger={onTrigger} />);

    fireEvent.change(screen.getByLabelText("Stock Code"), {
      target: { value: "CBA" },
    });
    fireEvent.click(triggerButton());
    expect(triggerButton()).toBeDisabled();

    await act(async () => {
      finish();
    });
    expect(triggerButton()).toBeEnabled();
  });

  it("clears the status when the next submit starts", async () => {
    let finish: () => void = () => undefined;
    let calls = 0;
    const onTrigger = jest.fn((_formData: FormData) => {
      calls += 1;
      if (calls === 1) return Promise.resolve(createdJob("job-1"));
      return new Promise<TriggerEnrichmentResult>((resolve) => {
        finish = () => resolve(createdJob("job-2"));
      });
    });
    render(<TriggerEnrichmentForm onTrigger={onTrigger} />);

    fireEvent.change(codeInput(), { target: { value: "CBA" } });
    fireEvent.click(triggerButton());
    await flush();
    expect(statusLine()).toHaveTextContent(/^Queued CBA\.$/);

    fireEvent.change(codeInput(), { target: { value: "BHP" } });
    fireEvent.click(forceBox());
    fireEvent.click(triggerButton());
    expect(statusLine().textContent).toBe("");
    expect(triggerButton()).toBeDisabled();

    await act(async () => {
      finish();
    });
    expect(statusLine()).toHaveTextContent(
      /^Queued BHP \(forced re-enrichment\)\.$/,
    );
  });

  it("sends a failed trigger to the nearest error boundary", async () => {
    const onTrigger = jest.fn(async (_formData: FormData) => {
      throw new Error("Failed to trigger enrichment: upstream unavailable");
    });
    render(
      <ErrorBoundary>
        <TriggerEnrichmentForm onTrigger={onTrigger} />
      </ErrorBoundary>,
    );

    fireEvent.change(codeInput(), { target: { value: "CBA" } });
    fireEvent.click(triggerButton());
    await flush();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Failed to trigger enrichment: upstream unavailable",
    );
    // What actually happens: the boundary replaces the form, so the typed code
    // goes with it and no queued line is shown. The form is never reset here.
    expect(screen.queryByLabelText("Stock Code")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText(/^Queued/)).toBeNull();
  });
});

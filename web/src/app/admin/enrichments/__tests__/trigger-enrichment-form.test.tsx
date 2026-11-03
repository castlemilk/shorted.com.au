import { Component, type ReactNode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { TriggerEnrichmentForm } from "../trigger-enrichment-form";

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

/** Lets a resolved or rejected trigger settle inside act. */
const flush = () =>
  act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

describe("TriggerEnrichmentForm", () => {
  it("submits the stock code and the force flag", async () => {
    const onTrigger = jest.fn(async (_formData: FormData) => ({ success: true }));
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

  // Regression: with <form action>, React 19 cleared both fields after a
  // successful trigger. The admin keeps the code and the force setting.
  it("keeps what the admin typed after a successful submit", async () => {
    const onTrigger = jest.fn(async (_formData: FormData) => ({ success: true }));
    render(<TriggerEnrichmentForm onTrigger={onTrigger} />);
    const code = screen.getByLabelText("Stock Code") as HTMLInputElement;
    const force = screen.getByLabelText(
      /Force re-enrichment/,
    ) as HTMLInputElement;

    fireEvent.change(code, { target: { value: "CBA" } });
    fireEvent.click(force);
    fireEvent.click(triggerButton());
    await flush();

    expect(onTrigger).toHaveBeenCalledTimes(1);
    expect(code.value).toBe("CBA");
    expect(force.checked).toBe(true);
  });

  it("disables the button while the trigger is queued", async () => {
    let finish: () => void = () => undefined;
    const onTrigger = jest.fn(
      () =>
        new Promise<unknown>((resolve) => {
          finish = () => resolve({ success: true });
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

  it("sends a failed trigger to the nearest error boundary", async () => {
    const onTrigger = jest.fn(async (_formData: FormData) => {
      throw new Error("Failed to trigger enrichment: upstream unavailable");
    });
    render(
      <ErrorBoundary>
        <TriggerEnrichmentForm onTrigger={onTrigger} />
      </ErrorBoundary>,
    );

    fireEvent.change(screen.getByLabelText("Stock Code"), {
      target: { value: "CBA" },
    });
    fireEvent.click(triggerButton());
    await flush();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Failed to trigger enrichment: upstream unavailable",
    );
  });
});

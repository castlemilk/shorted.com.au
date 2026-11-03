import { renderHook, act } from "@testing-library/react";
import { Component, type ReactNode } from "react";
import { useAsyncError, useAsyncErrorHandler } from "../use-async-error";

/**
 * Catches whatever the hook throws during render, as the nearest error
 * boundary does in the app. useAsyncErrorHandler is documented to hand its
 * error to that boundary. React 18 surfaced the error as a rejection of the
 * enclosing act(); React 19 routes it to the boundary and act resolves.
 */
class ErrorProbe extends Component<
  { children: ReactNode; onError: (error: unknown) => void },
  { caught: boolean }
> {
  state = { caught: false };

  static getDerivedStateFromError() {
    return { caught: true };
  }

  componentDidCatch(error: unknown) {
    this.props.onError(error);
  }

  render() {
    return this.state.caught ? null : this.props.children;
  }
}

function renderHookUnderBoundary<T>(useTestHook: () => T) {
  const onError = jest.fn<void, [unknown]>();
  const Boundary = ({ children }: { children: ReactNode }) => (
    <ErrorProbe onError={onError}>{children}</ErrorProbe>
  );
  const rendered = renderHook(useTestHook, { wrapper: Boundary });
  return { ...rendered, onError };
}

describe("useAsyncError", () => {
  it("throws error when called", () => {
    const { result } = renderHook(() => useAsyncError());
    const error = new Error("Test async error");

    expect(() => {
      act(() => {
        result.current(error);
      });
    }).toThrow("Test async error");
  });
});

describe("useAsyncErrorHandler", () => {
  it("returns result on successful async operation", async () => {
    const { result } = renderHook(() => useAsyncErrorHandler());

    const successfulOperation = async () => {
      return "success";
    };

    const outcome = await act(async () => {
      return await result.current(successfulOperation);
    });

    expect(outcome).toBe("success");
  });

  it("propagates error and returns null on failed async operation", async () => {
    const { result, onError } = renderHookUnderBoundary(() =>
      useAsyncErrorHandler()
    );

    const failingOperation = async () => {
      throw new Error("Test async failure");
    };

    let outcome: unknown = "not run";
    await act(async () => {
      outcome = await result.current(failingOperation);
    });

    expect(outcome).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
    const caught = onError.mock.calls[0]?.[0];
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("Test async failure");
  });

  it("converts non-Error exceptions to Error objects", async () => {
    const { result, onError } = renderHookUnderBoundary(() =>
      useAsyncErrorHandler()
    );

    const failingOperation = async () => {
      throw "string error";
    };

    await act(async () => {
      await result.current(failingOperation);
    });

    expect(onError).toHaveBeenCalledTimes(1);
    const caught = onError.mock.calls[0]?.[0];
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("string error");
  });
});

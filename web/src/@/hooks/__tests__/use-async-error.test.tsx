import { renderHook, act } from "@testing-library/react";
import { useAsyncError, useAsyncErrorHandler } from "../use-async-error";

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
    const { result } = renderHook(() => useAsyncErrorHandler());

    const failingOperation = async () => {
      throw new Error("Test async failure");
    };

    await expect(
      act(async () => {
        return await result.current(failingOperation);
      })
    ).rejects.toThrow("Test async failure");
  });

  it("converts non-Error exceptions to Error objects", async () => {
    const { result } = renderHook(() => useAsyncErrorHandler());

    const failingOperation = async () => {
      throw "string error";
    };

    await expect(
      act(async () => {
        return await result.current(failingOperation);
      })
    ).rejects.toThrow("string error");
  });
});
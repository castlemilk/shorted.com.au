import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ErrorBoundary, WidgetErrorBoundary } from "../error-boundary";

// Component that throws an error
const ThrowError = ({ shouldThrow }: { shouldThrow: boolean }) => {
  if (shouldThrow) {
    throw new Error("Test error");
  }
  return <div>No error</div>;
};

describe("ErrorBoundary", () => {
  // Suppress console errors during tests
  const originalError = console.error;
  beforeAll(() => {
    console.error = jest.fn();
  });

  afterAll(() => {
    console.error = originalError;
  });

  it("renders children when there is no error", () => {
    render(
      <ErrorBoundary>
        <div>Test content</div>
      </ErrorBoundary>
    );

    expect(screen.getByText("Test content")).toBeInTheDocument();
  });

  it("renders error UI when child component throws", () => {
    render(
      <ErrorBoundary>
        <ThrowError shouldThrow={true} />
      </ErrorBoundary>
    );

    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(screen.getByText("Try again")).toBeInTheDocument();
  });

  it("renders custom fallback when provided", () => {
    render(
      <ErrorBoundary fallback={<div>Custom error message</div>}>
        <ThrowError shouldThrow={true} />
      </ErrorBoundary>
    );

    expect(screen.getByText("Custom error message")).toBeInTheDocument();
  });

  it("resets error state when Try again is clicked", async () => {
    const { rerender } = render(
      <ErrorBoundary resetOnPropsChange={true}>
        <ThrowError shouldThrow={true} />
      </ErrorBoundary>
    );

    expect(screen.getByText("Something went wrong")).toBeInTheDocument();

    // Click Try again - this should reset the error boundary
    fireEvent.click(screen.getByText("Try again"));

    // Rerender with non-throwing component - this should show the content
    rerender(
      <ErrorBoundary resetOnPropsChange={true}>
        <ThrowError shouldThrow={false} />
      </ErrorBoundary>
    );

    // Wait for the component to update after reset
    await waitFor(() => {
      expect(screen.getByText("No error")).toBeInTheDocument();
    });
  });

  it("calls onError callback when error occurs", () => {
    const onError = jest.fn();

    render(
      <ErrorBoundary onError={onError}>
        <ThrowError shouldThrow={true} />
      </ErrorBoundary>
    );

    expect(onError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        componentStack: expect.any(String),
      })
    );
  });

  it("resets on resetKeys change", () => {
    const { rerender } = render(
      <ErrorBoundary resetKeys={["key1"]}>
        <ThrowError shouldThrow={true} />
      </ErrorBoundary>
    );

    expect(screen.getByText("Something went wrong")).toBeInTheDocument();

    // Change reset keys
    rerender(
      <ErrorBoundary resetKeys={["key2"]}>
        <ThrowError shouldThrow={false} />
      </ErrorBoundary>
    );

    expect(screen.getByText("No error")).toBeInTheDocument();
  });
});

describe("WidgetErrorBoundary", () => {
  // Suppress console errors during tests
  const originalError = console.error;
  beforeAll(() => {
    console.error = jest.fn();
  });

  afterAll(() => {
    console.error = originalError;
  });

  it("renders children when there is no error", () => {
    render(
      <WidgetErrorBoundary widgetName="Test Widget">
        <div>Widget content</div>
      </WidgetErrorBoundary>
    );

    expect(screen.getByText("Widget content")).toBeInTheDocument();
  });

  it("renders compact error UI for widgets", () => {
    render(
      <WidgetErrorBoundary widgetName="Test Widget">
        <ThrowError shouldThrow={true} />
      </WidgetErrorBoundary>
    );

    expect(screen.getByText("Error loading Test Widget")).toBeInTheDocument();
    expect(screen.getByText("Please try refreshing the page")).toBeInTheDocument();
  });
});
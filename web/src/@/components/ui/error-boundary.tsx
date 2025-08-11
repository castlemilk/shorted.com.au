"use client";

import React, { Component, type ReactNode } from "react";
import { AlertCircle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void;
  resetKeys?: Array<string | number>;
  resetOnPropsChange?: boolean;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    // Log error to console in development
    if (process.env.NODE_ENV === "development") {
      console.error("ErrorBoundary caught an error:", error, errorInfo);
    }

    // Call optional error handler
    if (this.props.onError) {
      this.props.onError(error, errorInfo);
    }
  }

  componentDidUpdate(prevProps: Props) {
    const { resetKeys, resetOnPropsChange } = this.props;
    const { hasError } = this.state;

    if (hasError && prevProps.resetKeys !== resetKeys) {
      if (resetKeys?.some((key, index) => key !== prevProps.resetKeys?.[index])) {
        this.resetErrorBoundary();
      }
    }

    if (hasError && resetOnPropsChange && prevProps.children !== this.props.children) {
      this.resetErrorBoundary();
    }
  }

  resetErrorBoundary = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    const { hasError, error } = this.state;
    const { fallback, children } = this.props;

    if (hasError) {
      if (fallback) {
        return <>{fallback}</>;
      }

      return (
        <Card className="p-6 m-4">
          <div className="flex flex-col items-center justify-center space-y-4 text-center">
            <AlertCircle className="h-12 w-12 text-red-500" />
            <div className="space-y-2">
              <h3 className="text-lg font-semibold">Something went wrong</h3>
              <p className="text-sm text-muted-foreground">
                This widget encountered an error and couldn't be displayed.
              </p>
              {process.env.NODE_ENV === "development" && error && (
                <details className="mt-4 text-left">
                  <summary className="cursor-pointer text-sm font-medium">
                    Error details
                  </summary>
                  <pre className="mt-2 overflow-auto rounded bg-muted p-2 text-xs">
                    {error.toString()}
                  </pre>
                </details>
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={this.resetErrorBoundary}
              className="mt-4"
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              Try again
            </Button>
          </div>
        </Card>
      );
    }

    return children;
  }
}

// Widget-specific error boundary with smaller UI
export function WidgetErrorBoundary({ 
  children, 
  widgetName = "Widget" 
}: { 
  children: ReactNode; 
  widgetName?: string;
}) {
  return (
    <ErrorBoundary
      fallback={
        <div className="flex h-full flex-col items-center justify-center p-6 text-center">
          <AlertCircle className="mb-2 h-8 w-8 text-muted-foreground" />
          <p className="text-sm font-medium">Error loading {widgetName}</p>
          <p className="text-xs text-muted-foreground mt-1">
            Please try refreshing the page
          </p>
        </div>
      }
    >
      {children}
    </ErrorBoundary>
  );
}
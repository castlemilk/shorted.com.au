"use client";

import { type ComponentType } from "react";
import { WidgetErrorBoundary } from "~/@/components/ui/error-boundary";
import { type WidgetProps } from "~/@/types/dashboard";

/**
 * Higher-order component that wraps a widget with an error boundary
 */
export function withErrorBoundary<P extends WidgetProps>(
  WrappedComponent: ComponentType<P>,
  widgetName?: string
) {
  const WithErrorBoundaryComponent = (props: P) => {
    return (
      <WidgetErrorBoundary widgetName={widgetName ?? props.config?.title ?? "Widget"}>
        <WrappedComponent {...props} />
      </WidgetErrorBoundary>
    );
  };

  WithErrorBoundaryComponent.displayName = 
    `withErrorBoundary(${WrappedComponent.displayName ?? WrappedComponent.name ?? "Component"})`;

  return WithErrorBoundaryComponent;
}
"use client";

import { Component, type ReactNode } from "react";

interface RichToolBoundaryProps {
  /** Drawn in place of the rich view when it throws: the raw tool result. */
  fallback: ReactNode;
  children: ReactNode;
}

interface RichToolBoundaryState {
  failed: boolean;
}

/**
 * Keeps a rich tool result from taking the message down with it. The parsers never
 * throw, but a formatter or a chart can still fail on an input nobody planned for.
 * The boundary draws the raw result instead. ChatSidebar sits in the root layout, so
 * an uncaught error here would otherwise reach the whole page.
 */
export class RichToolBoundary extends Component<
  RichToolBoundaryProps,
  RichToolBoundaryState
> {
  state: RichToolBoundaryState = { failed: false };

  static getDerivedStateFromError(): RichToolBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    if (process.env.NODE_ENV === "development") {
      console.error("A rich tool result failed to render; showing the raw result.", error);
    }
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { NextAuthProvider } from "../next-auth-provider";
import type { Session } from "next-auth";

// Mock SessionProvider from next-auth/react
jest.mock("next-auth/react", () => ({
  SessionProvider: ({ children, session }: any) => (
    <div data-testid="session-provider" data-session={JSON.stringify(session)}>
      {children}
    </div>
  ),
}));

describe("NextAuthProvider", () => {
  const mockSession: Session = {
    user: {
      id: "test-user-id",
      name: "Test User",
      email: "test@example.com",
      image: "https://example.com/avatar.jpg",
    },
    expires: "2024-12-31T23:59:59.999Z",
  };

  it("renders children wrapped in SessionProvider", () => {
    render(
      <NextAuthProvider>
        <div data-testid="test-child">Test Content</div>
      </NextAuthProvider>
    );

    expect(screen.getByTestId("session-provider")).toBeInTheDocument();
    expect(screen.getByTestId("test-child")).toBeInTheDocument();
    expect(screen.getByText("Test Content")).toBeInTheDocument();
  });

  it("passes session prop to SessionProvider when provided", () => {
    render(
      <NextAuthProvider session={mockSession}>
        <div data-testid="test-child">Test Content</div>
      </NextAuthProvider>
    );

    const provider = screen.getByTestId("session-provider");
    const sessionData = JSON.parse(provider.getAttribute("data-session") || "null");

    expect(sessionData).toEqual(mockSession);
    expect(sessionData.user.id).toBe("test-user-id");
    expect(sessionData.user.email).toBe("test@example.com");
  });

  it("passes null session to SessionProvider when not authenticated", () => {
    render(
      <NextAuthProvider session={null}>
        <div data-testid="test-child">Test Content</div>
      </NextAuthProvider>
    );

    const provider = screen.getByTestId("session-provider");
    const sessionData = JSON.parse(provider.getAttribute("data-session") || "null");

    expect(sessionData).toBeNull();
  });

  it("works without session prop (undefined)", () => {
    render(
      <NextAuthProvider>
        <div data-testid="test-child">Test Content</div>
      </NextAuthProvider>
    );

    const provider = screen.getByTestId("session-provider");
    const sessionData = provider.getAttribute("data-session");

    // When session is undefined, the mock might pass "undefined" or null
    expect(sessionData === "undefined" || sessionData === null || sessionData === "null").toBe(true);
  });

  it("renders multiple children correctly", () => {
    render(
      <NextAuthProvider session={mockSession}>
        <div data-testid="child-1">Child 1</div>
        <div data-testid="child-2">Child 2</div>
        <div data-testid="child-3">Child 3</div>
      </NextAuthProvider>
    );

    expect(screen.getByTestId("child-1")).toBeInTheDocument();
    expect(screen.getByTestId("child-2")).toBeInTheDocument();
    expect(screen.getByTestId("child-3")).toBeInTheDocument();
  });

  it("handles session updates correctly", () => {
    const { rerender } = render(
      <NextAuthProvider session={null}>
        <div data-testid="test-child">Test Content</div>
      </NextAuthProvider>
    );

    let provider = screen.getByTestId("session-provider");
    let sessionData = JSON.parse(provider.getAttribute("data-session") || "null");
    expect(sessionData).toBeNull();

    // Simulate session update after login
    rerender(
      <NextAuthProvider session={mockSession}>
        <div data-testid="test-child">Test Content</div>
      </NextAuthProvider>
    );

    provider = screen.getByTestId("session-provider");
    sessionData = JSON.parse(provider.getAttribute("data-session") || "null");
    expect(sessionData).toEqual(mockSession);
  });

  it("preserves all session properties", () => {
    const detailedSession: Session = {
      user: {
        id: "detailed-user-id",
        name: "Detailed User",
        email: "detailed@example.com",
        image: "https://example.com/detailed-avatar.jpg",
      },
      expires: "2025-12-31T23:59:59.999Z",
    };

    render(
      <NextAuthProvider session={detailedSession}>
        <div>Content</div>
      </NextAuthProvider>
    );

    const provider = screen.getByTestId("session-provider");
    const sessionData = JSON.parse(provider.getAttribute("data-session") || "null");

    expect(sessionData.user.id).toBe("detailed-user-id");
    expect(sessionData.user.name).toBe("Detailed User");
    expect(sessionData.user.email).toBe("detailed@example.com");
    expect(sessionData.user.image).toBe("https://example.com/detailed-avatar.jpg");
    expect(sessionData.expires).toBe("2025-12-31T23:59:59.999Z");
  });
});


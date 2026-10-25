import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const mockAuth = jest.fn();
jest.mock("~/server/auth", () => ({ auth: () => mockAuth() }));

const mockLookup = jest.fn();
jest.mock("~/server/account-verification", () => ({
  lookupAccountVerification: (uid: string) => mockLookup(uid),
}));

import { VerifyEmailNotice } from "../verify-email-notice";

const SIGNED_UP = { user: { id: "uid-1", email: "trader@example.com" } };

async function renderNotice() {
  // A server component is an async function that returns JSX, so it is awaited here.
  return render((await VerifyEmailNotice()) ?? <span data-testid="empty" />);
}

beforeEach(() => {
  mockAuth.mockReset();
  mockLookup.mockReset();
  mockAuth.mockResolvedValue(SIGNED_UP);
  mockLookup.mockResolvedValue({
    email: "trader@example.com",
    verified: false,
    hasPassword: true,
  });
});

describe("VerifyEmailNotice on the Premium success page", () => {
  it("tells an unverified password account to verify its address, and links to the alerts prompt", async () => {
    const { container } = await renderNotice();

    // The address sits in its own element, so match the notice's full text.
    expect(container).toHaveTextContent(
      "Verify trader@example.com to receive alert emails.",
    );
    expect(
      screen.getByRole("link", { name: "Verify your email" }),
    ).toHaveAttribute("href", "/alerts?verify=1");
  });

  it("renders nothing for a verified account", async () => {
    mockLookup.mockResolvedValue({
      email: "trader@example.com",
      verified: true,
      hasPassword: true,
    });
    await renderNotice();
    expect(screen.getByTestId("empty")).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("renders nothing for an account that signs in another way", async () => {
    mockLookup.mockResolvedValue({
      email: "trader@example.com",
      verified: false,
      hasPassword: false,
    });
    await renderNotice();
    expect(screen.getByTestId("empty")).toBeInTheDocument();
  });

  it("renders nothing when there is no session or the account cannot be read", async () => {
    mockAuth.mockResolvedValue(null);
    await renderNotice();
    expect(screen.getByTestId("empty")).toBeInTheDocument();

    mockAuth.mockResolvedValue(SIGNED_UP);
    mockLookup.mockResolvedValue(null);
    await renderNotice();
    expect(screen.getAllByTestId("empty").length).toBeGreaterThan(0);
  });
});

describe("the success page ships no client code for the notice", () => {
  const dir = join(__dirname, "..");
  const notice = readFileSync(join(dir, "verify-email-notice.tsx"), "utf8");
  const page = readFileSync(join(dir, "page.tsx"), "utf8");

  it("keeps the notice a server component: no client directive, no client session, no prompt", () => {
    expect(notice).not.toMatch(/"use client"/);
    expect(notice).not.toMatch(/next-auth\/react/);
    expect(notice).not.toMatch(/email-verification-prompt/);
    expect(notice).not.toMatch(/next\/dynamic/);
  });

  it("does not load the prompt, or any dynamic chunk, on the success page", () => {
    expect(page).not.toMatch(/email-verification-prompt/);
    expect(page).not.toMatch(/next\/dynamic/);
    expect(page).toMatch(/<VerifyEmailNotice \/>/);
  });
});

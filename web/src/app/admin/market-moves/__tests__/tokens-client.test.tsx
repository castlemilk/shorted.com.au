import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { MarketMovesToken } from "~/app/actions/admin/marketMovesTokens";

const mockCreate = jest.fn();
const mockRevoke = jest.fn();

jest.mock("~/app/actions/admin/marketMovesTokens", () => ({
  createMarketMovesToken: (...args: unknown[]) => mockCreate(...args),
  revokeMarketMovesToken: (...args: unknown[]) => mockRevoke(...args),
}));

import { MarketMovesTokensClient } from "../tokens-client";

function token(overrides: Partial<MarketMovesToken> = {}): MarketMovesToken {
  return {
    id: 1,
    name: "Old routine",
    prefix: "smm_oldold",
    status: "active",
    createdBy: "ben@shorted.com.au",
    createdAt: "2026-11-01T00:00:00Z",
    expiresAt: null,
    lastUsedAt: null,
    revokedAt: null,
    revokedBy: null,
    ...overrides,
  };
}

function renderClient(initial: MarketMovesToken[] = [token()], maxActive = 10) {
  return render(
    <MarketMovesTokensClient initial={initial} maxActive={maxActive} apiOrigin="https://api.shorted.com.au" />,
  );
}

beforeEach(() => jest.clearAllMocks());

describe("MarketMovesTokensClient", () => {
  it("lists tokens by prefix, never in full", () => {
    renderClient();
    expect(screen.getByText("Old routine")).toBeInTheDocument();
    expect(screen.getByText("smm_oldold…")).toBeInTheDocument();
    expect(screen.getByText("1 of 10 tokens active.")).toBeInTheDocument();
  });

  it("shows a new token once, then forgets it", async () => {
    mockCreate.mockResolvedValue({
      ok: true,
      secret: "smm_NEWsecretNEWsecretNEWsecretNEWsecretNEWse",
      token: token({ id: 2, name: "Claude routine", prefix: "smm_NEWsec" }),
    });
    renderClient();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Claude routine" } });
    fireEvent.change(screen.getByLabelText("Expires"), { target: { value: "365" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create token" }));
    });
    expect(mockCreate).toHaveBeenCalledWith({ name: "Claude routine", expiresInDays: 365 });
    expect(screen.getByTestId("new-token")).toHaveTextContent("smm_NEWsecretNEWsecretNEWsecretNEWsecretNEWse");
    expect(screen.getByText(/It will not be shown again/)).toBeInTheDocument();
    // The example request names the env var, never the token.
    expect(screen.getByText(/\$SHORTED_MARKET_MOVES_TOKEN/).textContent).not.toContain("smm_NEW");

    fireEvent.click(screen.getByRole("button", { name: "I have stored it" }));
    expect(screen.queryByTestId("new-token")).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("smm_NEWsecret");
    expect(screen.getByText("smm_NEWsec…")).toBeInTheDocument();
  });

  it("asks twice before revoking, and shows the refusal it gets", async () => {
    mockRevoke.mockResolvedValue({ ok: true, token: token({ status: "revoked", revokedAt: "2026-11-08T00:00:00Z", revokedBy: "ben" }) });
    renderClient();
    const row = screen.getByText("Old routine").closest("tr") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Revoke" }));
    expect(mockRevoke).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(within(row).getByRole("button", { name: "Revoke Old routine" }));
    });
    expect(mockRevoke).toHaveBeenCalledWith(1);
    expect(within(row).getByText("revoked")).toBeInTheDocument();
    expect(within(row).queryByRole("button")).not.toBeInTheDocument();
  });

  it("can cancel a revoke", () => {
    renderClient();
    const row = screen.getByText("Old routine").closest("tr") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Revoke" }));
    fireEvent.click(within(row).getByRole("button", { name: "Cancel" }));
    expect(within(row).getByRole("button", { name: "Revoke" })).toBeInTheDocument();
    expect(mockRevoke).not.toHaveBeenCalled();
  });

  it("refuses to create past the cap", () => {
    renderClient([token({ id: 1 }), token({ id: 2, name: "Second" })], 2);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Third" } });
    expect(screen.getByRole("button", { name: "Create token" })).toBeDisabled();
    expect(screen.getByText(/Revoke one to create another/)).toBeInTheDocument();
  });

  it("says why a create failed", async () => {
    mockCreate.mockResolvedValue({ ok: false, error: "the token was not created", fields: [{ field: "name", message: "too long" }] });
    renderClient();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "x" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create token" }));
    });
    expect(screen.getByRole("alert")).toHaveTextContent("the token was not created (name: too long)");
    expect(screen.queryByTestId("new-token")).not.toBeInTheDocument();
  });
});

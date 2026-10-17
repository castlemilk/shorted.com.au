import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useSession } from "next-auth/react";
import type { ReactElement } from "react";

import { StockEvidencePanelClient } from "../stock-evidence-panel-client";

// next-auth/react is mapped to src/test/__mocks__/next-auth-react.js, whose
// useSession defaults to an authenticated session.
const mockUseSession = useSession as unknown as jest.Mock;

function renderWithQueryClient(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

/** Where the lock card's sign-in link goes, and the return path it carries. */
function signInLink() {
  const link = screen.getByRole("link", {
    name: /sign in to unlock the dossier/i,
  });
  const url = new URL(link.getAttribute("href") ?? "", "https://shorted.invalid");
  return { pathname: url.pathname, callbackUrl: url.searchParams.get("callbackUrl") };
}

describe("StockEvidencePanelClient, signed out", () => {
  beforeEach(() => {
    mockUseSession.mockReturnValue({
      data: null,
      status: "unauthenticated",
      update: jest.fn(),
    });
  });

  it("returns the visitor to the page that hosts the dossier after sign-in", () => {
    renderWithQueryClient(
      <StockEvidencePanelClient stockCode="BHP" callbackUrl="/shorts/BHP/company" />,
    );
    expect(signInLink()).toEqual({
      pathname: "/signin",
      callbackUrl: "/shorts/BHP/company",
    });
  });

  it("returns to the stock's Overview when the host page names no return path", () => {
    renderWithQueryClient(<StockEvidencePanelClient stockCode="BHP" />);
    expect(signInLink()).toEqual({
      pathname: "/signin",
      callbackUrl: "/shorts/BHP",
    });
  });
});

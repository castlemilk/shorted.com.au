/// <reference types="jest" />
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

jest.mock("next-auth/react", () => ({ useSession: jest.fn() }));

const mockList = jest.fn();
const mockSave = jest.fn();
const mockUnsave = jest.fn();
jest.mock("~/app/actions/strategies/saved", () => ({
  listSavedStrategies: () => mockList(),
  saveStrategy: (ref: string) => mockSave(ref),
  unsaveStrategy: (ref: string) => mockUnsave(ref),
}));

const mockCapability = jest.fn(() => true);
jest.mock("~/@/lib/strategies/capabilities", () => ({
  strategyCapabilityEnabled: (name: string) => mockCapability(name),
}));

import { useSession } from "next-auth/react";
import { SaveStrategyButton } from "../save-strategy-button";

const mockUseSession = useSession as unknown as jest.Mock;
const SIGNED_IN = { data: { user: { id: "user-a" } }, status: "authenticated" };

function renderButton() {
  return render(<SaveStrategyButton strategyId="canslim" strategyName="CAN SLIM" />);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCapability.mockReturnValue(true);
});

describe("SaveStrategyButton", () => {
  it("draws nothing when the saves capability is off", () => {
    mockCapability.mockReturnValue(false);
    mockUseSession.mockReturnValue(SIGNED_IN);
    const { container } = renderButton();
    expect(container).toBeEmptyDOMElement();
    expect(mockList).not.toHaveBeenCalled();
  });

  it("draws nothing for an anonymous visitor, and reads nothing", () => {
    mockUseSession.mockReturnValue({ data: null, status: "unauthenticated" });
    const { container } = renderButton();
    expect(container).toBeEmptyDOMElement();
    expect(mockList).not.toHaveBeenCalled();
  });

  it("draws nothing while the session loads", () => {
    mockUseSession.mockReturnValue({ data: null, status: "loading" });
    const { container } = renderButton();
    expect(container).toBeEmptyDOMElement();
  });

  it("offers Save for a strategy the viewer has not saved, and saves it on the press", async () => {
    mockUseSession.mockReturnValue(SIGNED_IN);
    mockList.mockResolvedValue({ ok: true, strategies: [], limit: 20 });
    mockSave.mockResolvedValue({ ok: true, strategy: { strategyRef: "canslim" } });
    renderButton();
    const button = await screen.findByRole("button", { name: "Save CAN SLIM to My strategies" });
    expect(button).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByRole("button", { name: "Remove CAN SLIM from My strategies" })).toHaveAttribute("aria-pressed", "true"));
    expect(mockSave).toHaveBeenCalledWith("canslim");
  });

  it("shows Saved for a strategy already saved, and removes it on the press", async () => {
    mockUseSession.mockReturnValue(SIGNED_IN);
    mockList.mockResolvedValue({
      ok: true,
      limit: 20,
      strategies: [{ strategyRef: "canslim", strategyId: "canslim", name: "CAN SLIM", savedAt: "", counts: null }],
    });
    mockUnsave.mockResolvedValue({ ok: true });
    renderButton();
    fireEvent.click(await screen.findByRole("button", { name: "Remove CAN SLIM from My strategies" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save CAN SLIM to My strategies" })).toBeInTheDocument());
    expect(mockUnsave).toHaveBeenCalledWith("canslim");
  });

  it("says so at the cap, and keeps the strategy unsaved", async () => {
    mockUseSession.mockReturnValue(SIGNED_IN);
    mockList.mockResolvedValue({ ok: true, strategies: [], limit: 20 });
    mockSave.mockResolvedValue({ ok: false, reason: "limit" });
    renderButton();
    fireEvent.click(await screen.findByRole("button", { name: "Save CAN SLIM to My strategies" }));
    expect(await screen.findByText("You can save up to 20 strategies. Remove one to save another.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save CAN SLIM to My strategies" })).toHaveAttribute("aria-pressed", "false");
  });

  it("says a failed save failed, and changes nothing on the screen", async () => {
    mockUseSession.mockReturnValue(SIGNED_IN);
    mockList.mockResolvedValue({ ok: true, strategies: [], limit: 20 });
    mockSave.mockResolvedValue({ ok: false, reason: "unavailable" });
    renderButton();
    fireEvent.click(await screen.findByRole("button", { name: "Save CAN SLIM to My strategies" }));
    expect(await screen.findByText("Could not update your saved strategies. Try again.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save CAN SLIM to My strategies" })).toHaveAttribute("aria-pressed", "false");
  });
});

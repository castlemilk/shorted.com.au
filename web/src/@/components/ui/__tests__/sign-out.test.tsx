import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SignOut } from "../sign-out";
import { signOutFromBrowser } from "~/@/lib/auth-session";

const mockToast = jest.fn();
jest.mock("~/@/lib/auth-session", () => ({ signOutFromBrowser: jest.fn() }));
jest.mock("~/@/hooks/use-toast", () => ({ useToast: () => ({ toast: mockToast }) }));

describe("SignOut", () => {
  beforeEach(() => jest.clearAllMocks());

  it("prevents repeated requests while sign-out is pending", async () => {
    let finish!: () => void;
    jest.mocked(signOutFromBrowser).mockReturnValue(new Promise<void>((resolve) => {
      finish = resolve;
    }));
    render(<SignOut />);
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    const button = screen.getByRole("button", { name: "Signing out…" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    fireEvent.click(button);
    expect(signOutFromBrowser).toHaveBeenCalledTimes(1);
    finish();
    await waitFor(() => expect(mockToast).not.toHaveBeenCalled());
  });

  it("shows a retryable error if server sign-out fails", async () => {
    jest.mocked(signOutFromBrowser)
      .mockRejectedValueOnce(new Error("Network failed"))
      .mockResolvedValueOnce(undefined);
    render(<SignOut />);
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({
      title: "Could not sign out",
      variant: "destructive",
    })));
    expect(screen.getByRole("button", { name: "Sign out" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(signOutFromBrowser).toHaveBeenCalledTimes(2);
  });
});

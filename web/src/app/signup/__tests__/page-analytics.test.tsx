import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { getSession, signIn } from "next-auth/react";
import { createUserWithEmailAndPassword, signInWithPopup, getAdditionalUserInfo } from "firebase/auth";
import { trackSignupComplete } from "@/lib/signup-analytics";
import SignUpPage from "../page";

jest.mock("@/lib/firebase-client", () => ({ auth: {} }));
jest.mock("@/hooks/use-auth-preconnect", () => ({ useAuthPreconnect: jest.fn() }));
jest.mock("@/lib/signup-analytics", () => ({ trackSignupComplete: jest.fn() }));
jest.mock("firebase/auth", () => ({
  createUserWithEmailAndPassword: jest.fn(), signInWithPopup: jest.fn(),
  getAdditionalUserInfo: jest.fn(), updateProfile: jest.fn(),
  GoogleAuthProvider: class {},
}));
jest.mock("next-auth/react", () => ({ getSession: jest.fn(), signIn: jest.fn() }));

beforeEach(() => {
  jest.clearAllMocks();
  const credential = { user: { email: "private@example.com", getIdToken: jest.fn().mockResolvedValue("private-token") } };
  jest.mocked(createUserWithEmailAndPassword).mockResolvedValue(credential as never);
  jest.mocked(signInWithPopup).mockResolvedValue(credential as never);
  jest.mocked(getAdditionalUserInfo).mockReturnValue({ isNewUser: true } as never);
  jest.mocked(signIn).mockResolvedValue({ ok: true } as never);
  jest.mocked(getSession).mockResolvedValue({ user: { name: "Private" } } as never);
});

async function submitEmail() {
  render(<SignUpPage />);
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "private@example.com" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret123" } });
  fireEvent.change(screen.getByLabelText("Confirm Password"), { target: { value: "secret123" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign up" }));
  await waitFor(() => expect(getSession).toHaveBeenCalled());
}

it("counts an email signup after the Shorted session is confirmed", async () => {
  await submitEmail();
  expect(trackSignupComplete).toHaveBeenCalledTimes(1);
  expect(trackSignupComplete).toHaveBeenCalledWith("email");
});

it("does not count a missing Shorted session", async () => {
  jest.mocked(getSession).mockResolvedValue(null);
  await submitEmail();
  expect(trackSignupComplete).not.toHaveBeenCalled();
});

it.each([true, false])("counts Google new users only (isNewUser=%s)", async (isNewUser) => {
  jest.mocked(getAdditionalUserInfo).mockReturnValue({ isNewUser } as never);
  render(<SignUpPage />);
  fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
  await waitFor(() => expect(getSession).toHaveBeenCalled());
  expect(trackSignupComplete).toHaveBeenCalledTimes(isNewUser ? 1 : 0);
  if (isNewUser) expect(trackSignupComplete).toHaveBeenCalledWith("google");
});

it("does not count an account whose Shorted sign-in failed", async () => {
  jest.mocked(signIn).mockResolvedValue({ error: "failed", ok: false } as never);
  render(<SignUpPage />);
  fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
  await screen.findByText("Authentication failed. Please try again.");
  expect(trackSignupComplete).not.toHaveBeenCalled();
});

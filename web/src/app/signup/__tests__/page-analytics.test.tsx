import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { getSession, signIn } from "next-auth/react";
import {
  createUserWithEmailAndPassword,
  getAdditionalUserInfo,
} from "firebase/auth";
import { signInWithGoogle } from "@/lib/firebase-sign-in";
import { trackSignupComplete } from "@/lib/signup-analytics";
import SignUpPage from "../page";

const mockRefresh = jest.fn();
const mockReplace = jest.fn();

jest.mock("next/image", () => ({
  __esModule: true,
  default: (props: { src: string; alt?: string }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={props.src} alt={props.alt ?? ""} />
  ),
}));
jest.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: mockReplace, refresh: mockRefresh }),
}));
jest.mock("@/lib/firebase-client", () => ({ auth: {} }));
jest.mock("@/hooks/use-auth-preconnect", () => ({
  useAuthPreconnect: jest.fn(),
}));
jest.mock("@/lib/signup-analytics", () => ({ trackSignupComplete: jest.fn() }));
jest.mock("@/lib/remembered-login", () => ({ rememberLogin: jest.fn() }));
jest.mock("@/lib/firebase-sign-in", () => ({ signInWithGoogle: jest.fn() }));
jest.mock("firebase/auth", () => ({
  createUserWithEmailAndPassword: jest.fn(),
  getAdditionalUserInfo: jest.fn(),
  updateProfile: jest.fn(),
}));
jest.mock("next-auth/react", () => ({
  getSession: jest.fn(),
  signIn: jest.fn(),
}));

beforeEach(() => {
  jest.clearAllMocks();
  const credential = {
    user: {
      email: "private@example.com",
      getIdToken: jest.fn().mockResolvedValue("private-token"),
    },
  };
  jest
    .mocked(createUserWithEmailAndPassword)
    .mockResolvedValue(credential as never);
  jest.mocked(signInWithGoogle).mockResolvedValue(credential as never);
  jest
    .mocked(getAdditionalUserInfo)
    .mockReturnValue({ isNewUser: true } as never);
  jest.mocked(signIn).mockResolvedValue({ ok: true, error: null } as never);
});

function submitEmail() {
  render(<SignUpPage />);
  fireEvent.change(screen.getByLabelText("Email"), {
    target: { value: "private@example.com" },
  });
  fireEvent.change(screen.getByLabelText("Password"), {
    target: { value: "secret123" },
  });
  fireEvent.change(screen.getByLabelText("Confirm Password"), {
    target: { value: "secret123" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Sign up" }));
}

it("counts an email signup after server sign-in confirms the Shorted session", async () => {
  submitEmail();
  await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
  expect(trackSignupComplete).toHaveBeenCalledTimes(1);
  expect(trackSignupComplete).toHaveBeenCalledWith("email");
  expect(getSession).not.toHaveBeenCalled();
});

it("does not count an email account whose server sign-in failed", async () => {
  jest
    .mocked(signIn)
    .mockResolvedValue({ error: "failed", ok: false } as never);
  submitEmail();
  await screen.findByText(
    "Account created but sign-in failed. Please try signing in.",
  );
  expect(trackSignupComplete).not.toHaveBeenCalled();
  expect(mockRefresh).not.toHaveBeenCalled();
});

it.each([true, false])(
  "counts Google new users only (isNewUser=%s)",
  async (isNewUser) => {
    jest.mocked(getAdditionalUserInfo).mockReturnValue({ isNewUser } as never);
    render(<SignUpPage />);
    fireEvent.click(
      screen.getByRole("button", { name: "Continue with Google" }),
    );
    await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
    expect(trackSignupComplete).toHaveBeenCalledTimes(isNewUser ? 1 : 0);
    if (isNewUser) expect(trackSignupComplete).toHaveBeenCalledWith("google");
    expect(getSession).not.toHaveBeenCalled();
  },
);

it("does not count an account when Google new-user status is unknown", async () => {
  jest.mocked(getAdditionalUserInfo).mockReturnValue(null);
  render(<SignUpPage />);
  fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
  await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
  expect(trackSignupComplete).not.toHaveBeenCalled();
});

it("does not count a Google account whose Shorted sign-in failed", async () => {
  jest
    .mocked(signIn)
    .mockResolvedValue({ error: "failed", ok: false } as never);
  render(<SignUpPage />);
  fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
  await screen.findByText("Authentication failed. Please try again.");
  expect(trackSignupComplete).not.toHaveBeenCalled();
  expect(mockRefresh).not.toHaveBeenCalled();
});

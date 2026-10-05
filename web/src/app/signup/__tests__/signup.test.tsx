import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const mockSearchParams = { value: new URLSearchParams() };
const mockReplace = jest.fn();
const mockRefresh = jest.fn();
const mockSignIn = jest.fn();
const mockGetSession = jest.fn();
const mockGoogleSignIn = jest.fn();
const mockCreateUser = jest.fn();
const mockUpdateProfile = jest.fn();
const mockRememberLogin = jest.fn();
const mockGetIdToken = jest.fn();
const mockGetAdditionalUserInfo = jest.fn();
const mockTrackSignupComplete = jest.fn();

jest.mock("next/image", () => ({
  __esModule: true,
  default: (props: { src: string; alt?: string }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={props.src} alt={props.alt ?? ""} />
  ),
}));
jest.mock("next/navigation", () => ({
  useSearchParams: () => mockSearchParams.value,
  useRouter: () => ({ replace: mockReplace, refresh: mockRefresh }),
}));
jest.mock("next-auth/react", () => ({
  signIn: (...args: unknown[]) => mockSignIn(...args),
  getSession: (...args: unknown[]) => mockGetSession(...args),
}));
jest.mock("@/lib/firebase-client", () => ({ auth: {} }));
jest.mock("firebase/auth", () => ({
  createUserWithEmailAndPassword: (...args: unknown[]) =>
    mockCreateUser(...args),
  updateProfile: (...args: unknown[]) => mockUpdateProfile(...args),
  getAdditionalUserInfo: (...args: unknown[]) =>
    mockGetAdditionalUserInfo(...args),
}));
jest.mock("@/lib/signup-analytics", () => ({
  trackSignupComplete: (...args: unknown[]) => mockTrackSignupComplete(...args),
}));
jest.mock("@/lib/firebase-sign-in", () => ({
  signInWithGoogle: (...args: unknown[]) => mockGoogleSignIn(...args),
}));
jest.mock("@/lib/remembered-login", () => ({
  rememberLogin: (...args: unknown[]) => mockRememberLogin(...args),
}));
jest.mock("@/hooks/use-auth-preconnect", () => ({
  useAuthPreconnect: jest.fn(),
}));

import SignUpPage from "../page";

function submitPasswordSignup() {
  fireEvent.change(screen.getByLabelText(/^name/i), {
    target: { value: "Person" },
  });
  fireEvent.change(screen.getByLabelText(/^email$/i), {
    target: { value: "person@example.com" },
  });
  fireEvent.change(screen.getByLabelText(/^password$/i), {
    target: { value: "good-password" },
  });
  fireEvent.change(screen.getByLabelText(/^confirm password$/i), {
    target: { value: "good-password" },
  });
  fireEvent.submit(
    screen.getByRole("button", { name: /^sign up$/i }).closest("form")!,
  );
}

describe("sign-up completion", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSearchParams.value = new URLSearchParams({ callbackUrl: "/portfolio" });
    mockGetIdToken.mockResolvedValue("firebase-id-token");
    mockGetAdditionalUserInfo.mockReturnValue({ isNewUser: true });
    const user = {
      email: "person@example.com",
      displayName: "Person",
      photoURL: "https://lh3.googleusercontent.com/photo.jpg",
      getIdToken: mockGetIdToken,
    };
    mockGoogleSignIn.mockResolvedValue({ user });
    mockCreateUser.mockResolvedValue({ user });
    mockUpdateProfile.mockResolvedValue(undefined);
    mockSignIn.mockResolvedValue({ ok: true, error: null });
  });

  it("remembers Google login only after server sign-in succeeds and navigates without an extra session fetch", async () => {
    render(<SignUpPage />);
    fireEvent.click(
      screen.getByRole("button", { name: /continue with google/i }),
    );

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/portfolio"));
    expect(mockSignIn).toHaveBeenCalledWith(
      "credentials",
      expect.objectContaining({
        idToken: "firebase-id-token",
        email: "person@example.com",
        redirect: false,
        callbackUrl: "/portfolio",
      }),
    );
    expect(mockRememberLogin).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "person@example.com",
        method: "google",
      }),
    );
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it("remembers the new password account after signing in", async () => {
    render(<SignUpPage />);
    submitPasswordSignup();

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/portfolio"));
    expect(mockCreateUser).toHaveBeenCalledWith(
      {},
      "person@example.com",
      "good-password",
    );
    expect(mockUpdateProfile).toHaveBeenCalledWith(expect.anything(), {
      displayName: "Person",
    });
    expect(mockRememberLogin).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "person@example.com",
        method: "password",
      }),
    );
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it("submits browser autofill and generated passwords without change events", async () => {
    render(<SignUpPage />);
    (screen.getByLabelText(/^name/i) as HTMLInputElement).value =
      "Autofilled Person";
    (screen.getByLabelText(/^email$/i) as HTMLInputElement).value =
      " autofilled@example.com ";
    (screen.getByLabelText(/^password$/i) as HTMLInputElement).value =
      "browser-generated-password";
    (screen.getByLabelText(/^confirm password$/i) as HTMLInputElement).value =
      "browser-generated-password";
    fireEvent.submit(
      screen.getByRole("button", { name: /^sign up$/i }).closest("form")!,
    );

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/portfolio"));
    expect(mockCreateUser).toHaveBeenCalledWith(
      {},
      "autofilled@example.com",
      "browser-generated-password",
    );
    expect(mockUpdateProfile).toHaveBeenCalledWith(expect.anything(), {
      displayName: "Autofilled Person",
    });
  });

  it("does not cache a Google identity if server authentication fails", async () => {
    mockSignIn.mockResolvedValue({ ok: false, error: "CredentialsSignin" });
    render(<SignUpPage />);
    fireEvent.click(
      screen.getByRole("button", { name: /continue with google/i }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Authentication failed",
    );
    expect(mockRememberLogin).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: /continue with google/i }),
    ).toBeEnabled();
  });

  it("shows a recoverable error if account creation succeeds but no sign-in result is returned", async () => {
    mockSignIn.mockResolvedValue(undefined);
    render(<SignUpPage />);
    submitPasswordSignup();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Account created but sign-in failed",
    );
    expect(mockRememberLogin).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /^sign up$/i })).toBeEnabled();
  });

  it("preserves the requested destination when switching to sign in", () => {
    render(<SignUpPage />);
    expect(screen.getByRole("link", { name: /^sign in$/i })).toHaveAttribute(
      "href",
      "/signin?callbackUrl=%2Fportfolio",
    );
  });

  it("supports browser password generation and profile autofill", () => {
    render(<SignUpPage />);
    expect(screen.getByLabelText(/^name/i)).toHaveAttribute(
      "autocomplete",
      "name",
    );
    expect(screen.getByLabelText(/^email$/i)).toHaveAttribute(
      "autocomplete",
      "username",
    );
    expect(screen.getByLabelText(/^password$/i)).toHaveAttribute(
      "autocomplete",
      "new-password",
    );
    expect(screen.getByLabelText(/^confirm password$/i)).toHaveAttribute(
      "autocomplete",
      "new-password",
    );
  });
});

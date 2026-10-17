import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { signIn, getSession } from "next-auth/react";
import { signInWithEmailAndPassword, type User } from "firebase/auth";
import { restoreFirebaseUser, signInWithGoogle } from "@/lib/firebase-sign-in";
import { clearFirebaseSession } from "@/lib/auth-session";
import { auth as firebaseAuth } from "@/lib/firebase-client";
import { getRememberedLogin, rememberLogin } from "@/lib/remembered-login";
import SignInPage from "../page";

const mockReplace = jest.fn();
const mockRefresh = jest.fn();
const mockRouter = { replace: mockReplace, refresh: mockRefresh };
let mockParams = new URLSearchParams();
let mockStatus = "unauthenticated";

jest.mock("next/navigation", () => ({
  useSearchParams: () => mockParams,
  useRouter: () => mockRouter,
}));
jest.mock("next/image", () => ({
  __esModule: true,
  default: ({ src, alt }: { src: string; alt: string }) => (
    <img src={src} alt={alt} />
  ),
}));
jest.mock("next-auth/react", () => ({
  signIn: jest.fn(),
  getSession: jest.fn(),
  useSession: () => ({ data: null, status: mockStatus }),
}));
jest.mock("@/hooks/use-auth-preconnect", () => ({
  useAuthPreconnect: jest.fn(),
}));
jest.mock("@/lib/firebase-client", () => ({ auth: { currentUser: null } }));
jest.mock("firebase/auth", () => ({ signInWithEmailAndPassword: jest.fn() }));
jest.mock("@/lib/firebase-sign-in", () => ({
  restoreFirebaseUser: jest.fn(),
  signInWithGoogle: jest.fn(),
}));
jest.mock("@/lib/auth-session", () => ({ clearFirebaseSession: jest.fn() }));

function user(email = "trader@example.com"): User {
  return {
    uid: email,
    email,
    displayName: "Trader",
    photoURL: null,
    providerData: [{ providerId: "google.com" }],
    getIdToken: jest.fn().mockResolvedValue("verified-by-server"),
  } as unknown as User;
}

async function renderAfterIdleRestore() {
  await act(async () => {
    render(<SignInPage />);
    await Promise.resolve();
  });
}

describe("returning login", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    mockParams = new URLSearchParams({ callbackUrl: "/portfolio" });
    mockStatus = "unauthenticated";
    Object.assign(firebaseAuth!, { currentUser: null });
    jest.mocked(restoreFirebaseUser).mockResolvedValue(null);
    jest.mocked(clearFirebaseSession).mockResolvedValue(undefined);
    jest.mocked(signIn).mockResolvedValue({
      ok: true,
      error: undefined,
      status: 200,
      url: "/portfolio",
    });
  });

  it("restores the last account hint and supports forgetting it", async () => {
    rememberLogin({
      email: "trader@example.com",
      name: "Trader",
      method: "password",
    });
    await renderAfterIdleRestore();
    expect(
      screen.getByRole("button", { name: "Continue as Trader" }),
    ).toBeVisible();
    expect(screen.getByLabelText("Email")).toHaveValue("trader@example.com");
    expect(screen.getByLabelText("Email")).toHaveAttribute(
      "autocomplete",
      "username",
    );
    expect(screen.getByLabelText("Password")).toHaveAttribute(
      "autocomplete",
      "current-password",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Forget this account" }),
    );
    await waitFor(() => expect(clearFirebaseSession).toHaveBeenCalledTimes(1));
    expect(getRememberedLogin()).toBeNull();
    expect(screen.queryByText("Last used on this device")).toBeNull();
    expect(screen.getByLabelText("Email")).toHaveValue("");
  });

  it("keeps the shortcut forgotten when an earlier browser restore finishes late", async () => {
    rememberLogin({
      email: "trader@example.com",
      name: "Trader",
      method: "google",
    });
    let finishRestore!: (restored: User) => void;
    const restoring = new Promise<User>((resolve) => {
      finishRestore = resolve;
    });
    jest.mocked(restoreFirebaseUser).mockReturnValue(restoring);
    jest.mocked(clearFirebaseSession).mockImplementation(async () => {
      await restoring;
      Object.assign(firebaseAuth!, { currentUser: null });
    });
    render(<SignInPage />);

    fireEvent.click(screen.getByRole("button", { name: "Forget this account" }));
    expect(getRememberedLogin()).toBeNull();
    expect(screen.queryByText("Last used on this device")).toBeNull();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeDisabled();

    await act(async () => {
      const restored = user();
      Object.assign(firebaseAuth!, { currentUser: restored });
      finishRestore(restored);
      await restoring;
    });

    expect(screen.queryByText("Last used on this device")).toBeNull();
    expect(screen.getByLabelText("Email")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
    expect(getRememberedLogin()).toBeNull();
    expect(signIn).not.toHaveBeenCalled();
  });

  it("uses an actual restored Firebase user and verifies its token before navigating", async () => {
    rememberLogin({
      email: "trader@example.com",
      name: "Trader",
      method: "google",
    });
    const restored = user();
    Object.assign(firebaseAuth!, { currentUser: restored });
    jest.mocked(restoreFirebaseUser).mockResolvedValue(restored);
    await renderAfterIdleRestore();
    expect(restoreFirebaseUser).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Continue as Trader" }));
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/portfolio"));
    expect(signIn).toHaveBeenCalledWith(
      "credentials",
      expect.objectContaining({
        idToken: "verified-by-server",
        redirect: false,
      }),
    );
    expect(signInWithGoogle).not.toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it("does not treat a cached account as authenticated, and focuses the password when needed", async () => {
    rememberLogin({
      email: "trader@example.com",
      name: "Trader",
      method: "password",
    });
    jest
      .mocked(restoreFirebaseUser)
      .mockResolvedValue(user("someone-else@example.com"));
    await renderAfterIdleRestore();
    fireEvent.click(screen.getByRole("button", { name: "Continue as Trader" }));
    expect(screen.getByLabelText("Password")).toHaveFocus();
    expect(signIn).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("does not resume a stale Firebase user after another tab signs out", async () => {
    rememberLogin({
      email: "trader@example.com",
      name: "Trader",
      method: "password",
    });
    const restored = user();
    Object.assign(firebaseAuth!, { currentUser: restored });
    jest.mocked(restoreFirebaseUser).mockResolvedValue(restored);
    await renderAfterIdleRestore();
    Object.assign(firebaseAuth!, { currentUser: null });
    fireEvent.click(screen.getByRole("button", { name: "Continue as Trader" }));
    expect(signIn).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Password")).toHaveFocus();
  });

  it("supplies the remembered email to Google and can choose a different Google account", async () => {
    rememberLogin({
      email: "trader@example.com",
      name: "Trader",
      method: "google",
    });
    jest
      .mocked(signInWithGoogle)
      .mockRejectedValue({ code: "auth/popup-closed-by-user" });
    await renderAfterIdleRestore();
    fireEvent.click(screen.getByRole("button", { name: "Continue as Trader" }));
    expect(signInWithGoogle).toHaveBeenCalledWith({
      emailHint: "trader@example.com",
      chooseAccount: false,
    });
    await screen.findByRole("alert");
    fireEvent.click(
      screen.getByRole("button", { name: "Continue with Google" }),
    );
    expect(signInWithGoogle).toHaveBeenLastCalledWith({
      emailHint: undefined,
      chooseAccount: true,
    });
    await screen.findByRole("alert");
  });

  it("reads password-manager fills from the form even without React change events", async () => {
    jest
      .mocked(signInWithEmailAndPassword)
      .mockResolvedValue({ user: user() } as never);
    await renderAfterIdleRestore();
    const email = screen.getByLabelText("Email") as HTMLInputElement;
    const password = screen.getByLabelText("Password") as HTMLInputElement;
    email.value = "trader@example.com";
    password.value = "browser-filled-password";
    fireEvent.submit(email.closest("form")!);
    await waitFor(() =>
      expect(signInWithEmailAndPassword).toHaveBeenCalledWith(
        expect.anything(),
        "trader@example.com",
        "browser-filled-password",
      ),
    );
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/portfolio"));
    expect(getRememberedLogin()?.method).toBe("password");
    expect(JSON.stringify(getRememberedLogin())).not.toContain(
      "browser-filled-password",
    );
  });

  it("does not remember failed login and recovers from an empty server response", async () => {
    jest
      .mocked(signInWithEmailAndPassword)
      .mockResolvedValue({ user: user() } as never);
    jest.mocked(signIn).mockResolvedValue(undefined);
    await renderAfterIdleRestore();
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "trader@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "password" },
    });
    fireEvent.submit(screen.getByLabelText("Email").closest("form")!);
    await screen.findByRole("alert");
    expect(getRememberedLogin()).toBeNull();
    expect(mockReplace).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
  });

  it("preserves the destination when switching to signup and skips login for an active session", async () => {
    mockStatus = "authenticated";
    await renderAfterIdleRestore();
    expect(mockReplace).toHaveBeenCalledWith("/portfolio");
    expect(screen.getByRole("link", { name: "Sign up" })).toHaveAttribute(
      "href",
      "/signup?callbackUrl=%2Fportfolio",
    );
  });
});

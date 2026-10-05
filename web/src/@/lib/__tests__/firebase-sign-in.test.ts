const mockAuth = {
  currentUser: null as unknown,
  authStateReady: jest.fn(),
};
const mockClient: { auth: typeof mockAuth | undefined } = { auth: mockAuth };
const mockSetCustomParameters = jest.fn();
const mockSignInWithPopup = jest.fn();

jest.mock("@/lib/firebase-client", () => mockClient);
jest.mock("firebase/auth", () => ({
  GoogleAuthProvider: jest.fn(() => ({
    setCustomParameters: mockSetCustomParameters,
  })),
  signInWithPopup: (...args: unknown[]) => mockSignInWithPopup(...args),
}));

import { restoreFirebaseUser, signInWithGoogle } from "../firebase-sign-in";

describe("browser Firebase sign-in", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockClient.auth = mockAuth;
    mockAuth.currentUser = null;
    mockAuth.authStateReady.mockResolvedValue(undefined);
    mockSignInWithPopup.mockResolvedValue({
      user: { email: "person@example.com" },
    });
  });

  it("waits for the stored browser session to finish restoring", async () => {
    const storedUser = { email: "person@example.com" };
    let finishRestore!: () => void;
    mockAuth.authStateReady.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishRestore = resolve;
        }),
    );

    const restored = restoreFirebaseUser();
    expect(mockAuth.authStateReady).toHaveBeenCalledTimes(1);
    mockAuth.currentUser = storedUser;
    finishRestore();

    await expect(restored).resolves.toBe(storedUser);
  });

  it("returns no quick-login account when there is no stored session", async () => {
    await expect(restoreFirebaseUser()).resolves.toBeNull();
    mockClient.auth = undefined;
    await expect(restoreFirebaseUser()).resolves.toBeNull();
  });

  it("starts the Google popup immediately without waiting on persistence", async () => {
    const popup = signInWithGoogle();
    expect(mockSignInWithPopup).toHaveBeenCalledTimes(1);
    expect(mockAuth.authStateReady).not.toHaveBeenCalled();
    expect(mockSetCustomParameters).not.toHaveBeenCalled();
    await popup;
  });

  it("hints at the remembered Google account", async () => {
    await signInWithGoogle({ emailHint: "person@example.com" });
    expect(mockSetCustomParameters).toHaveBeenCalledWith({
      login_hint: "person@example.com",
    });
  });

  it("lets explicit account switching override the remembered account", async () => {
    await signInWithGoogle({
      emailHint: "person@example.com",
      chooseAccount: true,
    });
    expect(mockSetCustomParameters).toHaveBeenCalledWith({
      prompt: "select_account",
    });
  });

  it("fails clearly without Firebase and never opens a popup", async () => {
    mockClient.auth = undefined;
    await expect(signInWithGoogle()).rejects.toThrow(
      "Authentication service is not available",
    );
    expect(mockSignInWithPopup).not.toHaveBeenCalled();
  });
});

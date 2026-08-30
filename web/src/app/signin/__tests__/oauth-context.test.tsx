import { render, screen } from "@testing-library/react";

// next/image needs a base URL its loader can resolve, which jsdom does not
// provide.
jest.mock("next/image", () => ({
  __esModule: true,
  // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
  default: (props: { src: string; alt?: string }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={props.src} alt={props.alt ?? ""} />
  ),
}));

const mockSearchParams = { value: new URLSearchParams() };

jest.mock("next/navigation", () => ({
  useSearchParams: () => mockSearchParams.value,
  useRouter: () => ({ push: jest.fn(), refresh: jest.fn() }),
}));

jest.mock("next-auth/react", () => ({
  signIn: jest.fn(),
  getSession: jest.fn(),
}));

jest.mock("@/lib/firebase-client", () => ({ auth: {} }));

jest.mock("firebase/auth", () => ({
  signInWithEmailAndPassword: jest.fn(),
  signInWithPopup: jest.fn(),
  GoogleAuthProvider: jest.fn(),
}));

jest.mock("@/hooks/use-auth-preconnect", () => ({
  useAuthPreconnect: jest.fn(),
}));

import SignInPage from "../page";

function renderWith(callbackUrl?: string) {
  mockSearchParams.value = new URLSearchParams(
    callbackUrl ? { callbackUrl } : {},
  );
  return render(<SignInPage />);
}

// Someone who clicked "sign in" on the site is browsing. Someone who arrived
// from /oauth/authorize clicked "connect" in Claude or ChatGPT, watched a
// window open by itself, and needs a reason to believe they are in the right
// place. The two journeys should not read identically.
describe("the sign-in page in an OAuth flow", () => {
  it("explains that an application is waiting", () => {
    renderWith(
      "/oauth/authorize?client_id=abc&redirect_uri=http%3A%2F%2F127.0.0.1%3A51763%2Fcb",
    );

    expect(screen.getByText(/sign in to continue/i)).toBeInTheDocument();
    expect(screen.getByText(/authorise an application/i)).toBeInTheDocument();
    // And sets the expectation that consent comes next, so approving is not a
    // surprise.
    expect(screen.getByText(/before anything is shared/i)).toBeInTheDocument();
  });

  it("keeps the ordinary welcome for an ordinary sign-in", () => {
    renderWith("/portfolio");

    expect(screen.getByText(/welcome to shorted/i)).toBeInTheDocument();
    expect(screen.queryByText(/authorise an application/i)).toBeNull();
  });

  it("keeps the ordinary welcome when there is no callback at all", () => {
    renderWith();

    expect(screen.getByText(/welcome to shorted/i)).toBeInTheDocument();
    expect(screen.queryByText(/authorise an application/i)).toBeNull();
  });

  // The OAuth context is decided from the PATH, and a lookalike must not
  // trigger it. A page that says "an application is waiting to connect to your
  // Shorted account" is a useful thing for a phisher to be able to summon, so
  // it must only appear on the real authorize route.
  it("is not triggered by a path that merely starts the same way", () => {
    for (const lookalike of [
      "/oauth/authorize-evil?client_id=abc",
      "/oauth/authorizer",
      "/evil/oauth/authorize",
      "https://evil.example/oauth/authorize",
      "/oauth/authorizeX",
    ]) {
      const { unmount } = renderWith(lookalike);
      expect(screen.queryByText(/authorise an application/i)).toBeNull();
      expect(screen.getByText(/welcome to shorted/i)).toBeInTheDocument();
      unmount();
    }
  });

  // The bare path and the path with a query are both real: a client may send
  // either while a request is being assembled.
  it("is triggered by the bare authorize path as well as one with a query", () => {
    for (const real of ["/oauth/authorize", "/oauth/authorize?client_id=abc"]) {
      const { unmount } = renderWith(real);
      expect(screen.getByText(/authorise an application/i)).toBeInTheDocument();
      unmount();
    }
  });

  // Whichever header renders, the actual sign-in affordances must still be
  // there — the context is decoration on top of a working page.
  it("still offers every way to sign in", () => {
    renderWith("/oauth/authorize?client_id=abc");

    expect(
      screen.getByRole("button", { name: /continue with google/i }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
  });
});

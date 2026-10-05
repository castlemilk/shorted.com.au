"use client";

import { useEffect, useRef, useState, Suspense } from "react";
import Image from "next/image";
import Link from "next/link";
import { signIn, useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useAuthPreconnect } from "@/hooks/use-auth-preconnect";
import { useAuthCallback } from "@/hooks/use-auth-callback";
import { signInWithEmailAndPassword, type User } from "firebase/auth";
import { auth as firebaseAuth } from "@/lib/firebase-client";
import { restoreFirebaseUser, signInWithGoogle } from "@/lib/firebase-sign-in";
import { authPageHref } from "@/lib/auth-redirect";
import { clearFirebaseSession } from "@/lib/auth-session";
import {
  forgetRememberedLogin,
  getRememberedLogin,
  rememberLogin,
  type RememberedLogin,
} from "@/lib/remembered-login";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Loader2,
  AlertCircle,
  Lock,
  ArrowRight,
  Eye,
  EyeOff,
  UserRound,
  X,
} from "lucide-react";
import { GoogleLogo } from "@/components/ui/google-logo";
import { useSearchParams } from "next/navigation";

function getFirebaseErrorMessage(code: string): string {
  switch (code) {
    case "auth/invalid-email":
      return "Invalid email address.";
    case "auth/user-disabled":
      return "This account has been disabled.";
    case "auth/user-not-found":
      return "No account found with this email.";
    case "auth/wrong-password":
      return "Incorrect password.";
    case "auth/invalid-credential":
      return "Invalid email or password.";
    case "auth/too-many-requests":
      return "Too many attempts. Please try again later.";
    case "auth/popup-closed-by-user":
      return "Sign-in was cancelled. Please try again.";
    case "auth/popup-blocked":
      return "Pop-up was blocked by your browser. Please allow pop-ups for this site.";
    default:
      return "Failed to sign in. Please try again.";
  }
}

function SignInForm() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { callbackUrl, ready: callbackReady } = useAuthCallback(
    searchParams.get("callbackUrl"),
  );
  const { status } = useSession();

  // Is this sign-in the middle of an OAuth authorisation?
  //
  // It matters because the two journeys feel completely different. Someone who
  // clicked "sign in" on the site is browsing. Someone who arrived here from
  // /oauth/authorize clicked "connect" in Claude or ChatGPT, watched a browser
  // window open by itself, and landed on a page that — without this — says
  // "Sign in to access advanced features and insights" and gives them no reason
  // to believe they are in the right place.
  //
  // Matched on the PATH only, and deliberately not on anything inside the
  // query. The client_id there is attacker-supplied, and a sign-in page is the
  // last place to render an unvalidated name: the consent screen shows the
  // real, server-validated client on the very next step.
  const isOAuthFlow = (() => {
    if (!callbackUrl.startsWith("/oauth/authorize")) return false;
    const next = callbackUrl.charAt("/oauth/authorize".length);
    return next === "" || next === "?";
  })();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState<
    "google" | "password" | "resume" | "forget" | null
  >(null);
  const [remembered, setRemembered] = useState<RememberedLogin | null>(null);
  const [restoredUser, setRestoredUser] = useState<User | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const passwordInput = useRef<HTMLInputElement>(null);
  const busy = useRef(false);
  const restoreGeneration = useRef(0);
  const isBusy = pending !== null;
  useAuthPreconnect();

  useEffect(() => {
    let active = true;
    const generation = restoreGeneration.current;
    const lastLogin = getRememberedLogin();
    if (lastLogin) {
      setRemembered(lastLogin);
      setEmail(lastLogin.email);
    }
    // Restore through Firebase's persistence API while the form is idle.
    // Nothing is authenticated with Shorted until the user chooses Continue.
    void restoreFirebaseUser()
      .then((user) => {
        if (!active || generation !== restoreGeneration.current) return;
        if (user) setRestoredUser(user);
        if (!lastLogin && user?.email) {
          setRemembered({
            email: user.email,
            name: user.displayName,
            image: user.photoURL,
            method: user.providerData.some(
              (provider) => provider.providerId === "google.com",
            )
              ? "google"
              : "password",
          });
          setEmail((current) => (current ? current : (user.email ?? "")));
        }
      })
      .catch(() => {
        /* A failed restore leaves the normal login available. */
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (callbackReady && status === "authenticated" && !busy.current)
      router.replace(callbackUrl);
  }, [status, callbackUrl, callbackReady, router]);

  const completeSignIn = () => {
    // signIn(redirect:false) already refreshes the shared NextAuth session.
    router.replace(callbackUrl);
    router.refresh();
  };

  const signInFirebaseUser = async (
    user: User,
    method: RememberedLogin["method"],
  ) => {
    const idToken = await user.getIdToken();
    const result = await signIn("credentials", {
      idToken,
      email: user.email,
      callbackUrl,
      redirect: false,
    });
    if (!result?.ok || result.error) {
      throw new Error("Authentication failed. Please try again.");
    }
    if (user.email)
      rememberLogin({
        email: user.email,
        name: user.displayName,
        image: user.photoURL,
        method,
      });
    completeSignIn();
  };

  const handleGoogleSignIn = async (
    emailHint?: string,
    chooseAccount = false,
  ) => {
    if (busy.current) return;
    busy.current = true;
    setPending("google");
    setError(null);

    try {
      // Open immediately in this click, preserving the browser's popup permission.
      const credential = await signInWithGoogle({ emailHint, chooseAccount });
      await signInFirebaseUser(credential.user, "google");
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code === "auth/account-exists-with-different-credential") {
        setError(
          "An account already exists with this email using a different sign-in method.",
        );
      } else if (code) {
        setError(getFirebaseErrorMessage(code));
      } else {
        setError("Failed to sign in with Google. Please try again.");
      }
    } finally {
      busy.current = false;
      setPending(null);
    }
  };

  const handleContinue = async () => {
    if (!remembered || busy.current) return;
    // A different tab may have ended or switched the restored Firebase session.
    const currentUser = firebaseAuth?.currentUser;
    if (
      !currentUser ||
      currentUser.uid !== restoredUser?.uid ||
      currentUser.email?.toLowerCase() !== remembered.email.toLowerCase()
    ) {
      if (remembered.method === "google") {
        // No await before the popup. The idle restore is already complete or
        // the standard Google flow remains available while it settles.
        void handleGoogleSignIn(remembered.email);
      } else {
        setEmail(remembered.email);
        setError(null);
        passwordInput.current?.focus();
      }
      return;
    }
    busy.current = true;
    setPending("resume");
    setError(null);
    try {
      await signInFirebaseUser(currentUser, remembered.method);
    } catch {
      setRestoredUser(null);
      setError(
        "Your saved session has expired. Continue with Google or enter your password.",
      );
    } finally {
      busy.current = false;
      setPending(null);
    }
  };

  const handleForget = async () => {
    if (busy.current) return;
    busy.current = true;
    setPending("forget");
    restoreGeneration.current += 1;
    forgetRememberedLogin();
    setRemembered(null);
    setRestoredUser(null);
    setEmail("");
    setPassword("");
    setError(null);
    try {
      await clearFirebaseSession();
    } catch {
      setError(
        "The account shortcut was removed, but the saved session could not be cleared. Clear this site's browser data to remove it.",
      );
    } finally {
      busy.current = false;
      setPending(null);
    }
  };

  const handleCredentialsSignIn = async (
    e: React.FormEvent<HTMLFormElement>,
  ) => {
    e.preventDefault();
    if (busy.current) return;
    // Read the DOM so Chrome/password managers that fill without a React
    // change event still submit the credentials the visitor can see.
    const fields = new FormData(e.currentTarget);
    const submittedEmail = String(fields.get("email") ?? "").trim();
    const submittedPassword = String(fields.get("password") ?? "");
    busy.current = true;
    setPending("password");
    setError(null);
    let firebaseErrorCode: string | undefined;
    try {
      if (!submittedEmail || !submittedPassword) {
        setError("Please enter both email and password.");
        return;
      }
      if (firebaseAuth) {
        try {
          const credential = await signInWithEmailAndPassword(
            firebaseAuth,
            submittedEmail,
            submittedPassword,
          );
          await signInFirebaseUser(credential.user, "password");
          return;
        } catch (err: unknown) {
          firebaseErrorCode = (err as { code?: string }).code;
          if (!firebaseErrorCode) throw err;
        }
      }
      // Preserve the server-gated E2E path on local and preview deployments.
      const result = await signIn("credentials", {
        email: submittedEmail,
        password: submittedPassword,
        callbackUrl,
        redirect: false,
      });
      if (!result?.ok || result.error) {
        setError(
          firebaseErrorCode
            ? getFirebaseErrorMessage(firebaseErrorCode)
            : "Invalid email or password.",
        );
      } else {
        rememberLogin({ email: submittedEmail, method: "password" });
        completeSignIn();
      }
    } catch {
      setError("Failed to sign in. Please try again.");
    } finally {
      busy.current = false;
      setPending(null);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-muted/20">
      {/*
        Split on large screens: the brand holds the left, the form holds the
        right. Below lg it collapses to the single centred card it has always
        been — a two-column sign-in on a phone is just a logo pushing the form
        below the fold.
      */}
      <div className="mx-auto grid max-w-6xl items-center gap-10 px-4 py-6 sm:py-10 lg:min-h-[calc(100vh-8rem)] lg:grid-cols-2 lg:gap-16">
        <aside className="hidden lg:flex lg:flex-col lg:justify-center lg:gap-8">
          <div className="relative h-40 w-40">
            <Image
              src="/logo.png"
              alt="Shorted"
              fill
              sizes="160px"
              className="object-contain"
              priority
            />
          </div>
          <div className="space-y-4">
            <h1 className="text-4xl font-bold leading-tight tracking-tight">
              Track what the
              <br />
              market is <span className="text-primary">betting against</span>.
            </h1>
            <p className="max-w-md text-base leading-relaxed text-muted-foreground">
              Official ASIC short positions for every ASX-listed stock, updated
              daily. Plus house prices, economic series, and what your
              representatives declare.
            </p>
          </div>
          {isOAuthFlow ? (
            <div className="max-w-md rounded-lg border border-primary/25 bg-primary/5 p-4">
              <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                <Lock className="h-3.5 w-3.5" />
                <span>Connecting an application</span>
              </div>
              <p className="mt-2 text-sm text-muted-foreground">
                Read-only access, to data you can already see. Nothing is
                granted until you approve it on the next screen, and you can
                revoke it at any time.
              </p>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              Data sourced from ASIC with a T+4 trading day delay. Not financial
              advice.
            </p>
          )}
        </aside>

        <div className="flex min-w-0 w-full justify-center lg:justify-start">
          <Card className="min-w-0 w-full max-w-md shadow-lg">
            <CardHeader className="space-y-4 pb-6">
              <div className="flex justify-center lg:hidden">
                <div className="relative h-16 w-16">
                  <Image
                    src="/logo.png"
                    alt="Shorted Logo"
                    fill
                    sizes="64px"
                    className="object-contain"
                    priority
                  />
                </div>
              </div>
              <div className="text-center space-y-2 lg:text-left">
                {isOAuthFlow ? (
                  <>
                    <div className="flex items-center justify-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground lg:justify-start">
                      <Lock className="h-3.5 w-3.5" />
                      <span>Authorise an application</span>
                    </div>
                    <CardTitle className="text-3xl font-bold tracking-tight">
                      Sign in to continue
                    </CardTitle>
                    <CardDescription className="text-base">
                      An application is waiting to connect to your Shorted
                      account. You&rsquo;ll see exactly who is asking, and what
                      they can read, before anything is shared.
                    </CardDescription>
                  </>
                ) : (
                  <>
                    <CardTitle className="text-3xl font-bold tracking-tight">
                      {remembered ? "Welcome back" : "Welcome to Shorted"}
                    </CardTitle>
                    <CardDescription className="text-base">
                      {remembered
                        ? "Pick up where you left off."
                        : "Your watchlists, portfolio and insights, in one place."}
                    </CardDescription>
                  </>
                )}
              </div>
            </CardHeader>

            <CardContent className="space-y-6">
              {remembered && (
                <div className="rounded-lg border border-primary/20 bg-primary/5 p-4">
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-muted-foreground">
                      Last used on this device
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground"
                      aria-label="Forget this account"
                      onClick={handleForget}
                      disabled={isBusy}
                    >
                      <X className="h-4 w-4" aria-hidden="true" />
                    </Button>
                  </div>
                  <div className="mb-4 flex min-w-0 items-center gap-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-background text-primary">
                      {remembered.method === "google" ? (
                        <GoogleLogo className="h-5 w-5" />
                      ) : (
                        <UserRound className="h-5 w-5" aria-hidden="true" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">
                        {remembered.name?.trim()
                          ? remembered.name
                          : remembered.email}
                      </p>
                      {remembered.name && (
                        <p className="truncate text-xs text-muted-foreground">
                          {remembered.email}
                        </p>
                      )}
                    </div>
                  </div>
                  <Button
                    className="h-11 min-w-0 w-full gap-2 overflow-hidden"
                    onClick={handleContinue}
                    disabled={isBusy}
                  >
                    {pending === "resume" ||
                    (pending === "google" && remembered.method === "google") ? (
                      <Loader2
                        className="h-4 w-4 animate-spin"
                        aria-hidden="true"
                      />
                    ) : (
                      <ArrowRight className="h-4 w-4" aria-hidden="true" />
                    )}
                    <span className="truncate">
                      Continue as{" "}
                      {remembered.name?.trim()
                        ? remembered.name.trim().split(" ")[0]
                        : remembered.email}
                    </span>
                  </Button>
                </div>
              )}

              {error && (
                <div
                  role="alert"
                  className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
                >
                  <AlertCircle
                    className="mt-0.5 h-4 w-4 flex-shrink-0"
                    aria-hidden="true"
                  />
                  <span>{error}</span>
                </div>
              )}

              {/* Google Sign In */}
              <Button
                variant="outline"
                className="w-full h-12 text-base font-medium"
                onClick={() =>
                  handleGoogleSignIn(undefined, Boolean(remembered))
                }
                disabled={isBusy}
              >
                {pending === "google" ? (
                  <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                ) : (
                  <GoogleLogo className="mr-2 h-5 w-5" />
                )}
                Continue with Google
              </Button>

              {/* Divider */}
              <div className="relative">
                <div className="absolute inset-0 flex items-center">
                  <span className="w-full border-t" />
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-card px-2 text-muted-foreground">
                    Or continue with
                  </span>
                </div>
              </div>

              {/* Email/Password Form */}
              <form
                onSubmit={handleCredentialsSignIn}
                autoComplete="on"
                className="space-y-4"
              >
                <div className="space-y-2">
                  <label
                    htmlFor="email"
                    className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                  >
                    Email
                  </label>
                  <Input
                    id="email"
                    name="email"
                    type="email"
                    autoComplete="username"
                    inputMode="email"
                    autoCapitalize="none"
                    spellCheck={false}
                    placeholder="name@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    disabled={isBusy}
                    required
                    className="h-11"
                  />
                </div>

                <div className="space-y-2">
                  <label
                    htmlFor="password"
                    className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                  >
                    Password
                  </label>
                  <div className="relative">
                    <Input
                      ref={passwordInput}
                      id="password"
                      name="password"
                      type={showPassword ? "text" : "password"}
                      autoComplete="current-password"
                      placeholder="Enter your password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      disabled={isBusy}
                      required
                      className="h-11 pr-12"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="absolute right-1 top-1 h-9 w-9 text-muted-foreground"
                      aria-label={
                        showPassword ? "Hide password" : "Show password"
                      }
                      aria-pressed={showPassword}
                      onClick={() => setShowPassword((visible) => !visible)}
                      disabled={isBusy}
                    >
                      {showPassword ? (
                        <EyeOff className="h-4 w-4" aria-hidden="true" />
                      ) : (
                        <Eye className="h-4 w-4" aria-hidden="true" />
                      )}
                    </Button>
                  </div>
                </div>

                <Button
                  type="submit"
                  className="w-full h-11 text-base font-medium"
                  disabled={isBusy}
                >
                  {pending === "password" ? (
                    <>
                      <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                      Signing in...
                    </>
                  ) : (
                    "Sign in"
                  )}
                </Button>
              </form>

              {/* Sign Up Link */}
              <div className="text-center text-sm text-muted-foreground">
                Don&apos;t have an account?{" "}
                <Link
                  href={authPageHref("/signup", callbackUrl)}
                  className="font-medium text-primary underline underline-offset-4 hover:text-primary/80 transition-colors"
                >
                  Sign up
                </Link>
              </div>

              {/* Footer Text */}
              <div className="text-center text-sm text-muted-foreground pt-2">
                By signing in, you agree to our{" "}
                <a
                  href="/terms"
                  className="underline underline-offset-4 hover:text-foreground transition-colors"
                >
                  Terms of Service
                </a>{" "}
                and{" "}
                <a
                  href="/terms"
                  className="underline underline-offset-4 hover:text-foreground transition-colors"
                >
                  Privacy Policy
                </a>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

export default function SignInPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center">
          Loading...
        </div>
      }
    >
      <SignInForm />
    </Suspense>
  );
}

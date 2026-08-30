"use client";

import { useState, Suspense } from "react";
import Image from "next/image";
import Link from "next/link";
import { getSession, signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useAuthPreconnect } from "@/hooks/use-auth-preconnect";
import {
  signInWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
} from "firebase/auth";
import { auth as firebaseAuth } from "@/lib/firebase-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Loader2, AlertCircle, Lock } from "lucide-react";
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
  const callbackUrl = searchParams.get("callbackUrl") ?? "/";

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
  const [isLoading, setIsLoading] = useState(false);
  const [isGoogleLoading, setIsGoogleLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useAuthPreconnect();

  // Client navigation instead of the old full-document reload: getSession()
  // refreshes the SessionProvider cache (and broadcasts to other tabs),
  // router.refresh() re-renders server components with the new cookie —
  // skipping a full app re-parse between "signed in" and "sees signed-in UI".
  const completeSignIn = async () => {
    await getSession();
    router.push(callbackUrl);
    router.refresh();
  };

  const handleGoogleSignIn = async () => {
    if (!firebaseAuth) {
      setError("Firebase not initialized");
      return;
    }
    setIsGoogleLoading(true);
    setError(null);

    try {
      const provider = new GoogleAuthProvider();
      const userCredential = await signInWithPopup(firebaseAuth, provider);
      const idToken = await userCredential.user.getIdToken();

      const result = await signIn("credentials", {
        idToken,
        email: userCredential.user.email,
        callbackUrl,
        redirect: false,
      });

      if (result?.error) {
        setError("Authentication failed. Please try again.");
        setIsGoogleLoading(false);
      } else if (result?.ok) {
        await completeSignIn();
      }
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
      setIsGoogleLoading(false);
    }
  };

  const handleCredentialsSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);

    if (!email || !password) {
      setError("Please enter both email and password");
      setIsLoading(false);
      return;
    }

    let firebaseErrorCode: string | undefined;

    // Try Firebase auth first
    if (firebaseAuth) {
      try {
        const userCredential = await signInWithEmailAndPassword(
          firebaseAuth,
          email,
          password,
        );
        const idToken = await userCredential.user.getIdToken();

        const result = await signIn("credentials", {
          idToken,
          email,
          callbackUrl,
          redirect: false,
        });

        if (result?.error) {
          setError("Authentication failed. Please try again.");
          setIsLoading(false);
        } else if (result?.ok) {
          await completeSignIn();
        }
        return;
      } catch (err: unknown) {
        firebaseErrorCode = (err as { code?: string }).code;
      }
    }

    // Fallback: direct credentials (E2E test compatibility)
    try {
      const result = await signIn("credentials", {
        email,
        password,
        callbackUrl,
        redirect: false,
      });

      if (result?.error) {
        // Show Firebase error if we had one, otherwise generic message
        setError(
          firebaseErrorCode
            ? getFirebaseErrorMessage(firebaseErrorCode)
            : "Invalid email or password",
        );
        setIsLoading(false);
      } else if (result?.ok) {
        await completeSignIn();
      }
    } catch {
      setError(
        firebaseErrorCode
          ? getFirebaseErrorMessage(firebaseErrorCode)
          : "Failed to sign in. Please check your credentials.",
      );
      setIsLoading(false);
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
      <div className="mx-auto grid max-w-6xl items-center gap-10 px-4 py-10 lg:min-h-[calc(100vh-8rem)] lg:grid-cols-2 lg:gap-16">
        <aside className="hidden lg:flex lg:flex-col lg:justify-center lg:gap-8">
          <div className="relative h-40 w-40">
            <Image
              src="/logo.png"
              alt="Shorted"
              fill
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

        <div className="flex w-full justify-center lg:justify-start">
          <Card className="w-full max-w-md shadow-lg">
            <CardHeader className="space-y-4 pb-6">
              <div className="flex justify-center lg:hidden">
                <div className="relative w-32 h-32">
                  <Image
                    src="/logo.png"
                    alt="Shorted Logo"
                    fill
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
                      Welcome to Shorted
                    </CardTitle>
                    <CardDescription className="text-base">
                      Sign in to access advanced features and insights
                    </CardDescription>
                  </>
                )}
              </div>
            </CardHeader>

            <CardContent className="space-y-6">
              {/* Google Sign In */}
              <Button
                variant="outline"
                className="w-full h-12 text-base font-medium"
                onClick={handleGoogleSignIn}
                disabled={isGoogleLoading || isLoading}
              >
                {isGoogleLoading ? (
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
              <form onSubmit={handleCredentialsSignIn} className="space-y-4">
                <div className="space-y-2">
                  <label
                    htmlFor="email"
                    className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                  >
                    Email
                  </label>
                  <Input
                    id="email"
                    type="email"
                    placeholder="name@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    disabled={isLoading || isGoogleLoading}
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
                  <Input
                    id="password"
                    type="password"
                    placeholder="Enter your password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    disabled={isLoading || isGoogleLoading}
                    required
                    className="h-11"
                  />
                </div>

                {error && (
                  <div className="flex items-center gap-2 text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md">
                    <AlertCircle className="h-4 w-4 flex-shrink-0" />
                    <span>{error}</span>
                  </div>
                )}

                <Button
                  type="submit"
                  className="w-full h-11 text-base font-medium"
                  disabled={isLoading || isGoogleLoading}
                >
                  {isLoading ? (
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
                  href="/signup"
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

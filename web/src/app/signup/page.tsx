"use client";

import { useState, Suspense } from "react";
import Image from "next/image";
import Link from "next/link";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useAuthPreconnect } from "@/hooks/use-auth-preconnect";
import { useAuthCallback } from "@/hooks/use-auth-callback";
import {
  createUserWithEmailAndPassword,
  updateProfile,
  getAdditionalUserInfo,
} from "firebase/auth";
import { trackSignupComplete, type SignupMethod } from "@/lib/signup-analytics";
import { auth as firebaseAuth } from "@/lib/firebase-client";
import { signInWithGoogle } from "@/lib/firebase-sign-in";
import { authPageHref } from "@/lib/auth-redirect";
import { rememberLogin } from "@/lib/remembered-login";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Loader2, AlertCircle } from "lucide-react";
import { GoogleLogo } from "@/components/ui/google-logo";
import { useSearchParams } from "next/navigation";

function getFirebaseErrorMessage(code: string): string {
  switch (code) {
    case "auth/email-already-in-use":
      return "An account with this email already exists.";
    case "auth/invalid-email":
      return "Invalid email address.";
    case "auth/weak-password":
      return "Password should be at least 6 characters.";
    case "auth/operation-not-allowed":
      return "Email/password sign up is not enabled.";
    case "auth/too-many-requests":
      return "Too many attempts. Please try again later.";
    case "auth/popup-closed-by-user":
      return "Sign-up was cancelled. Please try again.";
    case "auth/popup-blocked":
      return "Pop-up was blocked by your browser. Please allow pop-ups for this site.";
    default:
      return "Failed to create account. Please try again.";
  }
}

function SignUpForm() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { callbackUrl } = useAuthCallback(searchParams.get("callbackUrl"));
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isGoogleLoading, setIsGoogleLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useAuthPreconnect();

  // signIn({ redirect: false }) already confirms the session and refreshes
  // SessionProvider. Count only new accounts after that sign-in succeeds.
  const completeSignIn = (method: SignupMethod, isNewUser: boolean) => {
    if (isNewUser) trackSignupComplete(method);
    router.replace(callbackUrl);
    router.refresh();
  };

  const handleGoogleSignUp = async () => {
    if (!firebaseAuth) {
      setError("Firebase not initialized");
      return;
    }
    setIsGoogleLoading(true);
    setError(null);

    try {
      const userCredential = await signInWithGoogle();
      const idToken = await userCredential.user.getIdToken();

      const result = await signIn("credentials", {
        idToken,
        email: userCredential.user.email,
        callbackUrl,
        redirect: false,
      });

      if (result?.ok && !result.error) {
        if (userCredential.user.email) {
          rememberLogin({
            email: userCredential.user.email,
            name: userCredential.user.displayName,
            image: userCredential.user.photoURL,
            method: "google",
          });
        }
        completeSignIn(
          "google",
          getAdditionalUserInfo(userCredential)?.isNewUser === true,
        );
      } else {
        setError("Authentication failed. Please try again.");
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
        setError("Failed to sign up with Google. Please try again.");
      }
    } finally {
      setIsGoogleLoading(false);
    }
  };

  const handleSignUp = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    // Chrome and password managers can fill inputs without firing onChange.
    const fields = new FormData(e.currentTarget);
    const submittedName = String(fields.get("name") ?? "").trim();
    const submittedEmail = String(fields.get("email") ?? "").trim();
    const submittedPassword = String(fields.get("password") ?? "");
    const submittedConfirmation = String(fields.get("confirmPassword") ?? "");
    setName(submittedName);
    setEmail(submittedEmail);
    setPassword(submittedPassword);
    setConfirmPassword(submittedConfirmation);
    setIsLoading(true);
    setError(null);

    if (!submittedEmail || !submittedPassword) {
      setError("Please fill in all required fields");
      setIsLoading(false);
      return;
    }

    if (submittedPassword !== submittedConfirmation) {
      setError("Passwords do not match");
      setIsLoading(false);
      return;
    }

    if (submittedPassword.length < 6) {
      setError("Password must be at least 6 characters");
      setIsLoading(false);
      return;
    }

    if (!firebaseAuth) {
      setError(
        "Authentication service is not available. Please try again later.",
      );
      setIsLoading(false);
      return;
    }

    try {
      const userCredential = await createUserWithEmailAndPassword(
        firebaseAuth,
        submittedEmail,
        submittedPassword,
      );

      if (submittedName) {
        await updateProfile(userCredential.user, {
          displayName: submittedName,
        });
      }

      const idToken = await userCredential.user.getIdToken();

      const result = await signIn("credentials", {
        idToken,
        email: userCredential.user.email ?? submittedEmail,
        callbackUrl,
        redirect: false,
      });

      if (result?.ok && !result.error) {
        rememberLogin({
          email: userCredential.user.email ?? submittedEmail,
          name: userCredential.user.displayName,
          image: userCredential.user.photoURL,
          method: "password",
        });
        completeSignIn("email", true);
      } else {
        setError("Account created but sign-in failed. Please try signing in.");
      }
    } catch (err: unknown) {
      const firebaseError = err as { code?: string };
      if (firebaseError.code) {
        setError(getFirebaseErrorMessage(firebaseError.code));
      } else {
        setError("Failed to create account. Please try again.");
      }
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background via-background to-muted/20 px-4 py-12">
      <Card className="w-full max-w-md shadow-lg">
        <CardHeader className="space-y-4 pb-6">
          <div className="flex justify-center">
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
          <div className="text-center space-y-2">
            <CardTitle className="text-3xl font-bold tracking-tight">
              Create an Account
            </CardTitle>
            <CardDescription className="text-base">
              Sign up to track short positions and build your portfolio
            </CardDescription>
          </div>
        </CardHeader>

        <CardContent className="space-y-6">
          {/* Google Sign Up */}
          <Button
            variant="outline"
            className="w-full h-12 text-base font-medium"
            onClick={handleGoogleSignUp}
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
                Or continue with email
              </span>
            </div>
          </div>

          <form onSubmit={handleSignUp} className="space-y-4">
            <div className="space-y-2">
              <label
                htmlFor="name"
                className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
              >
                Name{" "}
                <span className="text-muted-foreground font-normal">
                  (optional)
                </span>
              </label>
              <Input
                id="name"
                name="name"
                type="text"
                autoComplete="name"
                placeholder="Your name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={isLoading || isGoogleLoading}
                className="h-11"
              />
            </div>

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
                name="password"
                type="password"
                autoComplete="new-password"
                minLength={6}
                placeholder="At least 6 characters"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={isLoading || isGoogleLoading}
                required
                className="h-11"
              />
            </div>

            <div className="space-y-2">
              <label
                htmlFor="confirmPassword"
                className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
              >
                Confirm Password
              </label>
              <Input
                id="confirmPassword"
                name="confirmPassword"
                type="password"
                autoComplete="new-password"
                minLength={6}
                placeholder="Repeat your password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                disabled={isLoading || isGoogleLoading}
                required
                className="h-11"
              />
            </div>

            {error && (
              <div
                role="alert"
                className="flex items-center gap-2 text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md"
              >
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
                  Creating account...
                </>
              ) : (
                "Sign up"
              )}
            </Button>
          </form>

          {/* Sign In Link */}
          <div className="text-center text-sm text-muted-foreground">
            Already have an account?{" "}
            <Link
              href={authPageHref("/signin", callbackUrl)}
              className="font-medium text-primary underline underline-offset-4 hover:text-primary/80 transition-colors"
            >
              Sign in
            </Link>
          </div>

          {/* Footer Text */}
          <div className="text-center text-sm text-muted-foreground pt-2">
            By signing up, you agree to our{" "}
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
  );
}

export default function SignUpPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center">
          Loading...
        </div>
      }
    >
      <SignUpForm />
    </Suspense>
  );
}

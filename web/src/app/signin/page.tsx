import { Suspense } from "react";
import { redirect } from "next/navigation";
import { auth } from "~/server/auth";
import { SignInClient } from "./SignInClient";

interface SignInPageProps {
  searchParams: { callbackUrl?: string };
}

export default async function SignInPage({ searchParams }: SignInPageProps) {
  // SERVER-SIDE auth check - happens before page renders
  const session = await auth();
  const callbackUrl = searchParams.callbackUrl ?? "/";

  // If user is already authenticated, redirect them immediately
  if (session?.user) {
    console.log("[SignIn] Server-side redirect for authenticated user to:", callbackUrl);
    redirect(callbackUrl);
  }

  // Only render signin form if user is NOT authenticated
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center">Loading...</div>}>
      <SignInClient callbackUrl={callbackUrl} />
    </Suspense>
  );
}

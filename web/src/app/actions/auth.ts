"use server";

import { signIn as authSignIn } from "@/auth";

export async function signInAction() {
  await authSignIn();
}

export async function signInWithGoogle() {
  await authSignIn("google", { redirect: true, redirectTo: "/" });
}

export async function signInWithCredentials(email: string, password: string) {
  try {
    await authSignIn("credentials", {
      email,
      password,
      redirectTo: "/",
    });
    return { success: true };
  } catch (error) {
    // NextAuth throws a redirect error on successful auth, so we need to check
    if (error instanceof Error && error.message.includes("NEXT_REDIRECT")) {
      throw error; // Let the redirect happen
    }
    return {
      error: "Invalid email or password",
    };
  }
}

"use server";

import { signIn as authSignIn } from "@/auth";

export async function signInAction() {
  await authSignIn();
}

export async function signInWithGoogle() {
  await authSignIn("google", { redirect: true, redirectTo: "/" });
}

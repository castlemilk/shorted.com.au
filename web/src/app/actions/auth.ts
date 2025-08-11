"use server";

import { signIn as authSignIn } from "@/auth";

export async function signInAction() {
  await authSignIn();
}
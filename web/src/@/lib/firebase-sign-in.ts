import {
  GoogleAuthProvider,
  signInWithPopup,
  type User,
  type UserCredential,
} from "firebase/auth";
import { auth } from "./firebase-client";

/** Wait for Firebase's persisted browser session before offering a quick login. */
export async function restoreFirebaseUser(): Promise<User | null> {
  if (!auth) return null;
  await auth.authStateReady();
  return auth.currentUser;
}

export interface GoogleSignInOptions {
  emailHint?: string;
  chooseAccount?: boolean;
}

/** Uses the Google accounts available in this browser's existing session. */
export function signInWithGoogle({
  emailHint,
  chooseAccount = false,
}: GoogleSignInOptions = {}): Promise<UserCredential> {
  if (!auth) {
    return Promise.reject(
      new Error(
        "Authentication service is not available. Please try again later.",
      ),
    );
  }

  const provider = new GoogleAuthProvider();
  if (chooseAccount) {
    provider.setCustomParameters({ prompt: "select_account" });
  } else if (emailHint) {
    provider.setCustomParameters({ login_hint: emailHint });
  }

  // getAuth already persists browser sessions locally. Start the popup directly
  // in the click handler, preserving browser user activation for popup blockers.
  return signInWithPopup(auth, provider);
}

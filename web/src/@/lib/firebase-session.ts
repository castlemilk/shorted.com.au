import { signOut } from "firebase/auth";
import { auth } from "./firebase-client";

/** Clear SDK persistence after the existing browser credentials have restored. */
export async function clearPersistedFirebaseSession(): Promise<void> {
  if (!auth) return;
  await auth.authStateReady();
  await signOut(auth);
}

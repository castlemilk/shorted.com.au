import { getFirestore } from "firebase-admin/firestore";

import { getAdminApp } from "./firebase-admin";

// Firestore admin access, split from firebase-admin.ts so the /api/auth
// function (which only needs adminAuth) doesn't trace
// @google-cloud/firestore + google-gax + grpc-js into its bundle and cold
// start. Same lazy-Proxy pattern: initialization defers to first property
// access so builds with dummy CI credentials don't crash.
export const adminDb = new Proxy({} as ReturnType<typeof getFirestore>, {
  get(_, prop) {
    const db = getFirestore(getAdminApp());
    return (db as unknown as Record<string | symbol, unknown>)[prop];
  },
});

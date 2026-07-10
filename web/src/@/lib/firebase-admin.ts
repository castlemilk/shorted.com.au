import { initializeApp, cert, getApps, type App } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

// NOTE: keep firebase-admin/firestore OUT of this module. The /api/auth
// function imports adminAuth from here; a top-level firestore import drags
// @google-cloud/firestore + google-gax + grpc-js (~14MB) into that function's
// trace and its cold start. Firestore access lives in firebase-admin-db.ts.

export function normalizeFirebaseClientEmail(value: string | undefined) {
  return value?.trim().split(/\s+/)[0];
}

export function normalizeFirebasePrivateKey(value: string | undefined) {
  return value?.replace(/\\n/g, "\n");
}

export function getAdminApp(): App {
  if (getApps().length) {
    return getApps()[0]!;
  }

  const projectId = process.env.AUTH_FIREBASE_PROJECT_ID?.replace(/\s+/g, "");
  return initializeApp({
    credential: cert({
      projectId: projectId,
      clientEmail: normalizeFirebaseClientEmail(
        process.env.AUTH_FIREBASE_CLIENT_EMAIL,
      ),
      privateKey: normalizeFirebasePrivateKey(
        process.env.AUTH_FIREBASE_PRIVATE_KEY,
      ),
    }),
    projectId: projectId,
  });
}

// Lazy getters — initialization is deferred until first access,
// so module import during Next.js build won't crash with invalid CI credentials.
export const adminAuth = new Proxy({} as ReturnType<typeof getAuth>, {
  get(_, prop) {
    const auth = getAuth(getAdminApp());
    return (auth as unknown as Record<string | symbol, unknown>)[prop];
  },
});

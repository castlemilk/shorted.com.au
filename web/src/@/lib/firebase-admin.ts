import { initializeApp, cert, getApps, type App } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

function getApp(): App {
  if (getApps().length) {
    return getApps()[0]!;
  }

  const projectId = process.env.AUTH_FIREBASE_PROJECT_ID?.replace(/\s+/g, "");
  return initializeApp({
    credential: cert({
      projectId: projectId,
      clientEmail: process.env.AUTH_FIREBASE_CLIENT_EMAIL?.trim(),
      privateKey: process.env.AUTH_FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    }),
    projectId: projectId,
  });
}

// Lazy getters — initialization is deferred until first access,
// so module import during Next.js build won't crash with invalid CI credentials.
export const adminAuth = new Proxy({} as ReturnType<typeof getAuth>, {
  get(_, prop) {
    const auth = getAuth(getApp());
    return (auth as unknown as Record<string | symbol, unknown>)[prop];
  },
});

export const adminDb = new Proxy({} as ReturnType<typeof getFirestore>, {
  get(_, prop) {
    const db = getFirestore(getApp());
    return (db as unknown as Record<string | symbol, unknown>)[prop];
  },
});

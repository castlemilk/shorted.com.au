import { initFirestore } from "@auth/firebase-adapter";
import admin from "firebase-admin";

// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
export const firestore = initFirestore({
  credential: admin.credential.cert({
    projectId: process.env.AUTH_FIREBASE_PROJECT_ID,
    clientEmail: process.env.AUTH_FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.AUTH_FIREBASE_PRIVATE_KEY,
  }),
});

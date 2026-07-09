import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import { getAuth, type Auth } from "firebase/auth";
import { getFirestore, type Firestore } from "firebase/firestore";
import { normalizeFirebasePublicConfigValue } from "./firebase-public-config";

const firebaseConfig = {
  apiKey: normalizeFirebasePublicConfigValue(
    process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  ),
  authDomain: normalizeFirebasePublicConfigValue(
    process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  ),
  projectId: normalizeFirebasePublicConfigValue(
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  ),
  storageBucket: normalizeFirebasePublicConfigValue(
    process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  ),
  messagingSenderId: normalizeFirebasePublicConfigValue(
    process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  ),
  appId: normalizeFirebasePublicConfigValue(process.env.NEXT_PUBLIC_FIREBASE_APP_ID),
};

let app: FirebaseApp | undefined;
let auth: Auth | undefined;
let db: Firestore | undefined;

if (typeof window !== "undefined") {
  try {
    if (!getApps().length) {
      app = initializeApp(firebaseConfig);
    } else {
      app = getApps()[0];
    }
    
    if (app) {
      auth = getAuth(app);
      db = getFirestore(app);
      console.log("Firebase initialized successfully");
    }
  } catch (error) {
    console.error("Error initializing Firebase:", error);
  }
}

export { app, auth, db };

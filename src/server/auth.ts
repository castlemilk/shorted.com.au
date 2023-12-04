import {
  getServerSession,
  type DefaultSession,
  type NextAuthOptions,
} from "next-auth";
import GoogleProvider from "next-auth/providers/google"
import { FirestoreAdapter} from "@next-auth/firebase-adapter"

import { initializeApp } from 'firebase/app';
import "firebase/firestore"


import { env } from "~/env";
import { getFirestore } from "firebase/firestore";


// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyDhHWZyjPHi6sCzhU0rX27iEACzzG1igzE",
  authDomain: "shorted-dev-aba5688f.firebaseapp.com",
  projectId: "shorted-dev-aba5688f",
  storageBucket: "shorted-dev-aba5688f.appspot.com",
  messagingSenderId: "234770780438",
  appId: "1:234770780438:web:12f6c6a0fdfe7e6585c037",
  measurementId: "G-X85RLQ4N2N"
};

const firestore = initializeApp(firebaseConfig)
getFirestore(firestore)


/**
 * Module augmentation for `next-auth` types. Allows us to add custom properties to the `session`
 * object and keep type safety.
 *
 * @see https://next-auth.js.org/getting-started/typescript#module-augmentation
 */
declare module "next-auth" {
  interface Session extends DefaultSession {
    user: {
      id: string;
      // ...other properties
      // role: UserRole;
    } & DefaultSession["user"];
  }

  // interface User {
  //   // ...other properties
  //   // role: UserRole;
  // }
}

/**
 * Options for NextAuth.js used to configure adapters, providers, callbacks, etc.
 *
 * @see https://next-auth.js.org/configuration/options
 */
export const authOptions: NextAuthOptions = {
  callbacks: {
    session: ({ session, token }) => {
    console.log("callback: ", session, token)
    return {
      ...session,
      user: {
        ...session.user,
      },
    }},
  },
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_ID?.toString() || "",
      clientSecret: process.env.GOOGLE_SECRET?.toString() || "",
    }),
  ],
  adapter: FirestoreAdapter(firestore),
  debug: env.NODE_ENV === "development",
};

/**
 * Wrapper for `getServerSession` so that you don't need to import the `authOptions` in every file.
 *
 * @see https://next-auth.js.org/configuration/nextjs
 */
export const getServerAuthSession = () => getServerSession(authOptions);

import {
  getServerSession,
  type DefaultSession,
  type NextAuthOptions,
} from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { initializeApp } from "firebase/app";
import "firebase/firestore";

import { env } from "~/env";
import { getFirestore } from "firebase/firestore";
import { getAuth, signInAnonymously } from "firebase/auth";

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyDhHWZyjPHi6sCzhU0rX27iEACzzG1igzE",
  authDomain: "shorted-dev-aba5688f.firebaseapp.com",
  projectId: "shorted-dev-aba5688f",
  storageBucket: "shorted-dev-aba5688f.appspot.com",
  messagingSenderId: "234770780438",
  appId: "1:234770780438:web:12f6c6a0fdfe7e6585c037",
  measurementId: "G-X85RLQ4N2N",
};

const firestore = initializeApp(firebaseConfig);
getFirestore(firestore);

/**
 * Module augmentation for `next-auth` types. Allows us to add custom properties to the `session`
 * object and keep type safety.
 *
 * @see https://next-auth.js.org/getting-started/typescript#module-augmentation
 */
declare module "next-auth" {
  interface Session extends DefaultSession {
    accessToken?: string;
    user: User & DefaultSession["user"];
  }

  interface User {
    id: string;
    name: string;
    email: string;
    image: string;
    accessToken?: string;
  }
}

/**
 * Options for NextAuth.js used to configure adapters, providers, callbacks, etc.
 *
 * @see https://next-auth.js.org/configuration/options
 */
export const authOptions: NextAuthOptions = {
  callbacks: {
    async jwt({ token, user}) {
      if (user) {
        token.accessToken = user.accessToken;
      }
      return token;
    },
    session: ({ session }) => {
      return session
      // return {
      //   ...session,
      //   user: {
      //     ...session.user,
      //     accessToken: token.accessToken,
      //   },
      // };
    },

  },
  session: {
    strategy: "jwt",
  },
  providers: [
    CredentialsProvider({
      name: "annonymous",
      credentials: {},
      async authorize() {
        const auth = getAuth(firestore);
        const user = await signInAnonymously(auth);
        const token = await user.user.getIdToken();
        console.log("generated access token: ", token);
        return {
          id: "annonymous",
          name: "annonymous",
          email: "annonymous",
          image: "", // Add the missing 'image' property
          accessToken: token,
        };
      },
    })
  ],
  // adapter: FirestoreAdapter(firestore),
  debug: env.NODE_ENV === "development",
};

/**
 * Wrapper for `getServerSession` so that you don't need to import the `authOptions` in every file.
 *
 * @see https://next-auth.js.org/configuration/nextjs
 */
export const getServerAuthSession = () => getServerSession(authOptions);



export const getIdToken = async (): Promise<string> => {
  const auth = getAuth(firestore);
  const user = await signInAnonymously(auth);
  const token = await user.user.getIdToken();
  return token;
}
import NextAuth from "next-auth";
import { FirestoreAdapter } from "@auth/firebase-adapter";
import Google from "next-auth/providers/google";
import Credentials from "next-auth/providers/credentials";

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
// const firebaseConfig = {
//   apiKey: "AIzaSyDhHWZyjPHi6sCzhU0rX27iEACzzG1igzE",
//   authDomain: "shorted-dev-aba5688f.firebaseapp.com",
//   projectId: "shorted-dev-aba5688f",
//   storageBucket: "shorted-dev-aba5688f.appspot.com",
//   messagingSenderId: "234770780438",
//   appId: "1:234770780438:web:12f6c6a0fdfe7e6585c037",
//   measurementId: "G-X85RLQ4N2N",
// };

import { firestore } from "~/app/lib/firestore";

/**
 * Module augmentation for `next-auth` types. Allows us to add custom properties to the `session`
 * object and keep type safety.
 *
 * @see https://next-auth.js.org/getting-started/typescript#module-augmentation
 */
// declare module "next-auth" {
//   interface Session extends DefaultSession {
//     accessToken?: string;
//     user: User & DefaultSession["user"];
//   }

//   interface User {
//     id: string;
//     name: string;
//     email: string;
//     image: string;
//     accessToken?: string;
//   }
// }

/**
 * Options for NextAuth.js used to configure adapters, providers, callbacks, etc.
 *
 * @see https://next-auth.js.org/configuration/options
 */
export const authOptions = {
  providers: [
    Credentials({
      // You can specify which fields should be submitted, by adding keys to the `credentials` object.
      // e.g. domain, username, password, 2FA token, etc.
      credentials: {
        email: {},
        password: {},
      },
      authorize: async (credentials) => {
        let user = null;

        // logic to salt and hash password
        const pwHash = saltAndHashPassword(credentials.password);

        // logic to verify if the user exists
        user = await getUserFromDb(credentials.email, pwHash);

        if (!user) {
          // No user found, so this is their first attempt to login
          // meaning this is also the place you could do registration
          throw new Error("User not found.");
        }

        // return user object with their profile data
        return user;
      },
    }),
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    }),
  ],
  adapter: FirestoreAdapter(firestore),
  debug: process.env.NODE_ENV === "development",
};

export const { handlers, signIn, signOut, auth } = NextAuth(authOptions);
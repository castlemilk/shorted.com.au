import NextAuth, { type Session, type User } from "next-auth";
import Google from "next-auth/providers/google";
import Credentials from "next-auth/providers/credentials";
import { type AdapterUser } from "next-auth/adapters";

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

// import { firestore } from "~/app/lib/firestore"; // Commented out until Firebase adapter is used

// TODO: Implement these auth functions
function saltAndHashPassword(password: string): string {
  // Stub implementation - replace with actual hashing
  return password;
}

async function getUserFromDb(_email: string, _passwordHash: string) {
  // Stub implementation - replace with actual database lookup
  return null;
}

/**
 * Module augmentation for `next-auth` types. Allows us to add custom properties to the `session`
 * object and keep type safety.
 *
 * @see https://next-auth.js.org/getting-started/typescript#module-augmentation
 */
declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      name?: string | null;
      email?: string | null;
      image?: string | null;
    };
  }
}

/**
 * Options for NextAuth.js used to configure adapters, providers, callbacks, etc.
 *
 * @see https://next-auth.js.org/configuration/options
 */
export const authOptions = {
  pages: {
    signIn: "/signin",
  },
  providers: [
    Credentials({
      // You can specify which fields should be submitted, by adding keys to the `credentials` object.
      // e.g. domain, username, password, 2FA token, etc.
      credentials: {
        email: {},
        password: {},
      },
      authorize: async (credentials) => {
        if (!credentials?.email || !credentials?.password) {
          return null;
        }

        let user = null;

        // logic to salt and hash password
        const pwHash = saltAndHashPassword(credentials.password as string);

        // logic to verify if the user exists
        user = await getUserFromDb(credentials.email as string, pwHash);

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
      clientId: process.env.AUTH_GOOGLE_ID,
      clientSecret: process.env.AUTH_GOOGLE_SECRET,
    }),
  ],
  // adapter: FirestoreAdapter(firestore), // Commented out until Firebase adapter issues are resolved
  callbacks: {
    session: ({
      session,
      user,
    }: {
      session: Session;
      user: User | AdapterUser;
    }) => {
      return {
        ...session,
        user: {
          ...session.user,
          id: user?.id ?? session.user.email ?? "unknown",
        },
      };
    },
  },
  debug: process.env.NODE_ENV === "development",
};

export const { handlers, signIn, signOut, auth } = NextAuth(authOptions);

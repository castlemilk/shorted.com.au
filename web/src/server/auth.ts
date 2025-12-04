import NextAuth, { type Session, type User } from "next-auth";
import Google from "next-auth/providers/google";
import Credentials from "next-auth/providers/credentials";
import type { JWT } from "next-auth/jwt";
import type { AdapterUser } from "next-auth/adapters";

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

// E2E Test User - only enabled in non-production environments
// This allows Playwright tests to authenticate without OAuth
const E2E_TEST_USER = {
  email: process.env.E2E_TEST_EMAIL ?? "e2e-test@shorted.com.au",
  password: process.env.E2E_TEST_PASSWORD ?? "E2ETestPassword123!",
  id: "e2e-test-user",
  name: "E2E Test User",
};

// TODO: Implement these auth functions for production users
function saltAndHashPassword(password: string): string {
  // Stub implementation - replace with actual hashing
  return password;
}

async function getUserFromDb(
  email: string,
  passwordHash: string,
): Promise<User | null> {
  // In non-production, allow E2E test user to authenticate
  // This enables automated testing with Playwright
  if (process.env.NODE_ENV !== "production" || process.env.ALLOW_E2E_AUTH === "true") {
    if (
      email === E2E_TEST_USER.email &&
      passwordHash === E2E_TEST_USER.password
    ) {
      return {
        id: E2E_TEST_USER.id,
        email: E2E_TEST_USER.email,
        name: E2E_TEST_USER.name,
      };
    }
  }

  // Stub implementation for other users - replace with actual database lookup
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

declare module "next-auth/jwt" {
  interface JWT {
    id?: string;
  }
}

/**
 * Options for NextAuth.js used to configure adapters, providers, callbacks, etc.
 *
 * @see https://next-auth.js.org/configuration/options
 */
export const authOptions = {
  trustHost: true, // Required for Vercel and production environments
  secret: process.env.NEXTAUTH_SECRET,
  session: {
    strategy: "jwt" as const,
    maxAge: 30 * 24 * 60 * 60, // 30 days
  },
  cookies: {
    sessionToken: {
      name: `${process.env.NODE_ENV === "production" ? "__Secure-" : ""}next-auth.session-token`,
      options: {
        httpOnly: true,
        sameSite: "lax" as const,
        path: "/",
        secure: process.env.NODE_ENV === "production",
      },
    },
  },
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
    // JWT callback runs first - when JWT is created or updated
    async jwt({
      token,
      user,
    }: {
      token: JWT;
      user?: User | AdapterUser;
    }): Promise<JWT> {
      // On initial sign in, user object is provided
      if (user) {
        // Use email as the consistent user ID to maintain compatibility with existing data
        token.id = user.email ?? user.id ?? token.sub ?? "unknown";
        token.email = user.email ?? token.email;
        token.name = user.name ?? token.name;
        token.picture = user.image ?? token.picture;
        // CRITICAL: Preserve or set sub for middleware checks
        if (!token.sub) {
          token.sub = user.id ?? user.email ?? "unknown";
        }
      }

      // CRITICAL: Always ensure sub is set - middleware depends on this
      // This handles cases where token is refreshed without user object
      if (!token.sub && token.email) {
        token.sub = token.email;
      }
      if (!token.sub && token.id) {
        token.sub = String(token.id);
      }

      // Ensure token.id is always set (preserve it on token refresh)
      if (!token.id && token.email) {
        token.id = token.email;
      }

      return token;
    },
    // Session callback runs after JWT - when session is checked
    async session({
      session,
      token,
    }: {
      session: Session;
      token: JWT;
    }): Promise<Session> {
      // Add user ID from token to session
      // Use email as the consistent user ID to maintain compatibility with existing data
      if (session.user) {
        session.user.id =
          token.id ?? session.user.email ?? token.sub ?? "unknown";
      }
      return session;
    },
  },
  debug: process.env.NODE_ENV === "development",
};

export const { handlers, signIn, signOut, auth } = NextAuth(authOptions);

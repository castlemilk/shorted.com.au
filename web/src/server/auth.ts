import NextAuth, { type Session, type User } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import type { JWT } from "next-auth/jwt";
import type { AdapterUser } from "next-auth/adapters";
import { adminAuth } from "@/lib/firebase-admin";
import { parseAdminEmails } from "./admin-emails";
import { lookupAccountVerification } from "./account-verification";
import {
  e2eTestEmail,
  e2eTestPassword,
  isDevOrTestRuntime,
  isE2eTestEmail,
} from "~/server/e2e-identity";

// E2E test user. Its email and password come from e2e-identity.ts, which gives the
// hard-coded password only to a development or test runtime.
const E2E_TEST_USER = {
  id: "e2e-test-user",
  name: "E2E Test User",
};

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
      isAdmin?: boolean;
      emailVerified?: boolean;
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id?: string;
    isAdmin?: boolean;
    emailVerified?: boolean;
  }
}

/**
 * The Credentials provider's user. authorize() adds the verification flag here
 * rather than augmenting next-auth's User: AdapterUser extends User with
 * `emailVerified: Date | null`, and widening User would conflict with it.
 */
type CredentialsUser = User & { emailVerified?: boolean };

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
      credentials: {
        email: {},
        password: {},
        idToken: {},
      },
      authorize: async (credentials) => {
        const email = credentials?.email as string | undefined;
        const password = credentials?.password as string | undefined;
        const idToken = credentials?.idToken as string | undefined;

        // Path 1: Firebase ID token verification
        if (idToken) {
          try {
            const decoded = await adminAuth.verifyIdToken(idToken);
            // Only the verified token's email counts. The credentials email is
            // client-supplied, and a token with no email claim (an anonymous
            // account) would otherwise take any address the caller chose. Checkout
            // reuses the Stripe customer found by session email, and the
            // subscription upsert then removes another user's row for that customer.
            const user: CredentialsUser = {
              id: decoded.uid,
              email: decoded.email ?? null,
              name: (decoded.name as string) ?? null,
              image: decoded.picture ?? null,
              // The admin decision rests on this. Without it an unverified
              // email/password account could claim an admin's address.
              emailVerified: decoded.email_verified === true,
            };
            return user;
          } catch (error) {
            console.error("[Auth] Firebase ID token verification failed:", error);
            return null;
          }
        }

        // Path 2: E2E test user fallback (no idToken)
        if (!email || !password) {
          return null;
        }

        // On Vercel, NODE_ENV is always "production" for both preview and prod.
        // Use VERCEL_ENV to distinguish: "production" = real prod, "preview" = PR deploys.
        const isRealProduction =
          process.env.VERCEL_ENV === "production" ||
          (process.env.NODE_ENV === "production" && !process.env.VERCEL_ENV);
        const allowE2E =
          !isRealProduction && process.env.ALLOW_E2E_AUTH === "true";

        if (process.env.NODE_ENV === "development") {
          console.log("[Auth] E2E fallback check:", { email, allowE2E });
        }

        const e2ePassword = e2eTestPassword();
        if (
          allowE2E &&
          e2ePassword !== undefined &&
          email === e2eTestEmail() &&
          password === e2ePassword
        ) {
          if (process.env.NODE_ENV === "development") {
            console.log("[Auth] E2E test user authenticated successfully");
          }
          const user: CredentialsUser = {
            id: E2E_TEST_USER.id,
            email: e2eTestEmail(),
            name: E2E_TEST_USER.name,
            emailVerified: true,
          };
          return user;
        }

        return null;
      },
    }),
  ],
  callbacks: {
    // JWT callback runs first - when JWT is created or updated
    async jwt({
      token,
      user,
      trigger,
    }: {
      token: JWT;
      user?: User | AdapterUser;
      trigger?: "signIn" | "signUp" | "update";
    }): Promise<JWT> {
      // On initial sign in, user object is provided
      if (user) {
        // Use the provider's user ID first (e.g., Google OAuth ID or Firebase UID)
        // to maintain compatibility with existing Firebase data stored under that ID
        token.id = user.id ?? user.email ?? token.sub ?? "unknown";
        token.email = user.email ?? token.email;
        token.name = user.name ?? token.name;
        token.picture = user.image ?? token.picture;
        // CRITICAL: Preserve or set sub for middleware checks
        if (!token.sub) {
          token.sub = user.id ?? user.email ?? "unknown";
        }
        // Only sign-in carries the provider's verdict, set by authorize(). Refreshes
        // arrive without a user object, so the flag is kept on the token from here
        // on. Anything other than an explicit true reads as unverified.
        token.emailVerified = (user as CredentialsUser).emailVerified === true;
      }

      // The client asked for a refresh (useSession().update()), which is how a user
      // who has clicked the verification link picks it up without signing out. Only
      // an upgrade is taken, and only from Firebase's current account, never from
      // the client's payload. A failed lookup leaves the flag as it was.
      if (
        trigger === "update" &&
        token.emailVerified !== true &&
        typeof token.id === "string"
      ) {
        const account = await lookupAccountVerification(token.id);
        if (account?.verified) token.emailVerified = true;
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
      // Fall back to email only if no ID was set from the provider
      if (!token.id && token.email) {
        token.id = token.email;
      }

      // Admin check. An allowlisted address is not enough on its own: an
      // email/password account can be registered under any address, so admin
      // also needs the provider to have verified the email. Sessions minted
      // before emailVerified existed have no flag and are not admin until the
      // holder signs in again.
      const adminEmails = parseAdminEmails(process.env.ADMIN_EMAILS);

      // The E2E test identity is an admin only in a development or test runtime. It
      // never takes admin through the allowlist, so ADMIN_EMAILS cannot grant it
      // anywhere else.
      const isTestUser =
        isDevOrTestRuntime() && isE2eTestEmail(token.email);
      token.isAdmin =
        isTestUser ||
        (token.emailVerified === true &&
          !isE2eTestEmail(token.email) &&
          adminEmails.includes((token.email ?? "").trim().toLowerCase()));

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
      // Use the token.id which was set from the provider's user ID (e.g., Google OAuth ID or Firebase UID)
      // This maintains compatibility with existing Firebase data
      if (session.user) {
        session.user.id =
          token.id ?? token.sub ?? session.user.email ?? "unknown";
        session.user.isAdmin = token.isAdmin;
        session.user.emailVerified = token.emailVerified === true;
      }
      return session;
    },
  },
  debug: process.env.NODE_ENV === "development",
};

export const { handlers, signIn, signOut, auth } = NextAuth(authOptions);

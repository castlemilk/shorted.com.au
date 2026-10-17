"use client";

import { useEffect, useRef } from "react";
import { SessionProvider, useSession } from "next-auth/react";
import { type Session } from "next-auth";
import { clearUserSessionCaches } from "~/@/lib/auth-session";

type Props = {
  children?: React.ReactNode;
  session?: Session | null;
};

function AccountCacheLifecycle() {
  const { data: session, status } = useSession();
  const previousAccount = useRef<string | null | undefined>(undefined);
  const account = session?.user?.id ?? session?.user?.email ?? null;

  useEffect(() => {
    if (status === "loading") return;

    const previous = previousAccount.current;
    previousAccount.current = account;
    if ((previous !== undefined && previous !== null && previous !== account) || !account) {
      // Covers account changes and sign-out events received from another tab.
      void clearUserSessionCaches(previous ?? undefined).catch(() => undefined);
    }
  }, [account, status]);

  return null;
}

export const NextAuthProvider = ({ children, session }: Props) => (
  <SessionProvider session={session}>
    <AccountCacheLifecycle />
    {children}
  </SessionProvider>
);

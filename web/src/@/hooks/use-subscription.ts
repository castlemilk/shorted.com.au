"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import type { SubscriptionInfo } from "~/app/actions/subscription";
import { getSubscriptionStatus } from "~/app/actions/subscription";

interface UseSubscriptionResult {
  isPremium: boolean;
  isLoading: boolean;
  tier: string;
  subscription: SubscriptionInfo | null;
}

export function useSubscription(): UseSubscriptionResult {
  const { data: session, status: authStatus } = useSession();
  const [subscription, setSubscription] = useState<SubscriptionInfo | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (authStatus === "loading") return;

    if (!session?.user) {
      setSubscription(null);
      setIsLoading(false);
      return;
    }

    let cancelled = false;

    async function fetchSubscription() {
      try {
        const info = await getSubscriptionStatus();
        if (!cancelled) {
          setSubscription(info);
        }
      } catch {
        // Fall back to no subscription on error
        if (!cancelled) {
          setSubscription(null);
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    void fetchSubscription();

    return () => {
      cancelled = true;
    };
  }, [session?.user, authStatus]);

  return {
    isPremium: subscription?.isPremium ?? false,
    isLoading: authStatus === "loading" || isLoading,
    tier: subscription?.tier ?? "free",
    subscription,
  };
}

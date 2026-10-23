"use client";

import { useSession } from "next-auth/react";
import { useQuery } from "@tanstack/react-query";
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

  const { data: subscription = null, isLoading: queryLoading } = useQuery<SubscriptionInfo | null>({
    queryKey: ["subscription", session?.user?.id],
    queryFn: async () => {
      const info = await getSubscriptionStatus();
      // A failed lookup is not an answer. Throwing keeps it out of the cache as
      // a success, so the next mount or retry asks again instead of holding
      // "free" for the whole staleTime. Any earlier good answer is kept.
      if (info.lookupFailed) {
        throw new Error("Subscription lookup failed");
      }
      return info;
    },
    enabled: authStatus !== "loading" && !!session?.user,
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    refetchOnReconnect: false,
  });

  const isLoading = authStatus === "loading" || (!!session?.user && queryLoading);

  return {
    isPremium: subscription?.isPremium ?? false,
    isLoading,
    tier: subscription?.tier ?? "free",
    subscription,
  };
}

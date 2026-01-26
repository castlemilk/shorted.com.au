"use client";

import React, { useEffect, useState } from "react";
import { SubscriptionGate } from "./subscription-gate";
import { TokenGenerator } from "./token-generator";
import type { SubscriptionInfo } from "~/app/actions/subscription";
import { Loader2 } from "lucide-react";

interface ApiAccessSectionProps {
  priceId: string;
}

export function ApiAccessSection({ priceId }: ApiAccessSectionProps) {
  const [subscription, setSubscription] = useState<SubscriptionInfo | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchSubscription() {
      try {
        // Import dynamically to avoid issues with server actions in client component
        const { getSubscriptionStatus } = await import("~/app/actions/subscription");
        const status = await getSubscriptionStatus();
        setSubscription(status);
      } catch (error) {
        console.error("Failed to fetch subscription:", error);
      } finally {
        setLoading(false);
      }
    }

    void fetchSubscription();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <SubscriptionGate subscription={subscription} priceId={priceId}>
      <TokenGenerator />
    </SubscriptionGate>
  );
}

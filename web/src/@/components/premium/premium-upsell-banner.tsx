"use client";

import Link from "next/link";
import { Sparkles, ArrowRight } from "lucide-react";
import { useSession } from "next-auth/react";
import { useSubscription } from "~/@/hooks/use-subscription";

export function PremiumUpsellBanner() {
  const { data: session, status } = useSession();
  const { isPremium, isLoading } = useSubscription();

  // Don't show for: unauthenticated users, premium users, or while loading
  if (status === "loading" || isLoading || !session || isPremium) {
    return null;
  }

  return (
    <div className="container mx-auto px-4 pb-4">
      <Link
        href="/pricing"
        className="group flex items-center justify-between rounded-lg border border-primary/20 bg-gradient-to-r from-primary/5 via-primary/10 to-primary/5 p-3 hover:border-primary/40 transition-colors"
      >
        <div className="flex items-center gap-3">
          <div className="p-1.5 bg-primary/10 rounded-md">
            <Sparkles className="h-4 w-4 text-primary" />
          </div>
          <div>
            <p className="text-sm font-medium">
              Unlock AI Chat, Pulse, Alerts & more
            </p>
            <p className="text-xs text-muted-foreground">
              Upgrade to Premium for just $4/mo
            </p>
          </div>
        </div>
        <ArrowRight className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors shrink-0 ml-2" />
      </Link>
    </div>
  );
}

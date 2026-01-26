"use client";

import React, { useState } from "react";
import { Button } from "~/@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/@/components/ui/card";
import {
  Zap,
  Check,
  Loader2,
  CreditCard,
  ExternalLink,
  Settings,
} from "lucide-react";
import { useSession } from "next-auth/react";
import { cn } from "~/@/lib/utils";
import type { SubscriptionInfo } from "~/app/actions/subscription";

interface SubscriptionGateProps {
  subscription: SubscriptionInfo | null;
  priceId: string;
  children: React.ReactNode;
}

export function SubscriptionGate({
  subscription,
  priceId,
  children,
}: SubscriptionGateProps) {
  const { data: session, status } = useSession();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubscribe = async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/stripe/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ priceId }),
      });

      const data = (await response.json()) as { url?: string; error?: string };

      if (!response.ok) {
        throw new Error(data.error ?? "Failed to create checkout session");
      }

      if (data.url) {
        window.location.href = data.url;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setLoading(false);
    }
  };

  const handleManageSubscription = async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/stripe/portal", {
        method: "POST",
      });

      const data = (await response.json()) as { url?: string; error?: string };

      if (!response.ok) {
        throw new Error(data.error ?? "Failed to create portal session");
      }

      if (data.url) {
        window.location.href = data.url;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setLoading(false);
    }
  };

  if (status === "loading") {
    return (
      <Card className="border-dashed">
        <CardContent className="py-8 flex items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  // Not signed in
  if (!session) {
    return (
      <Card className="border-dashed">
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Zap className="h-5 w-5 text-yellow-500" />
            API Access
          </CardTitle>
          <CardDescription>
            Sign in to subscribe and get API access.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" asChild className="w-full">
            <a href="/signin">Sign In to Get Started</a>
          </Button>
        </CardContent>
      </Card>
    );
  }

  // Has active subscription - show token generator
  if (subscription?.canMintTokens) {
    return (
      <div className="space-y-4">
        {children}

        {/* Subscription management link */}
        <div className="flex items-center justify-between text-xs text-muted-foreground bg-zinc-100 dark:bg-zinc-900 p-3 rounded-lg">
          <div className="flex items-center gap-2">
            <Check className={cn("h-4 w-4", subscription.cancelAtPeriodEnd ? "text-yellow-500" : "text-green-500")} />
            <span>
              {subscription.tier.charAt(0).toUpperCase() +
                subscription.tier.slice(1)}{" "}
              plan {subscription.cancelAtPeriodEnd ? "canceling" : "active"}
              {subscription.currentPeriodEnd && (
                <span className="text-zinc-500">
                  {" "}
                  · {subscription.cancelAtPeriodEnd ? "Ends" : "Renews"}{" "}
                  {new Date(subscription.currentPeriodEnd).toLocaleDateString()}
                </span>
              )}
            </span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={handleManageSubscription}
            disabled={loading}
          >
            {loading ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <>
                <Settings className="h-3 w-3 mr-1" />
                Manage
              </>
            )}
          </Button>
        </div>
      </div>
    );
  }

  // No subscription - show pricing
  return (
    <Card
      className={cn(
        "relative overflow-hidden transition-all duration-300",
        "border-blue-500/30 shadow-lg shadow-blue-500/5"
      )}
    >
      {/* Gradient accent */}
      <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-blue-500 via-purple-500 to-pink-500" />

      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg flex items-center gap-2">
            <Zap className="h-5 w-5 text-yellow-500" />
            Unlock API Access
          </CardTitle>
          <span className="text-2xl font-bold">
            $29<span className="text-sm font-normal text-muted-foreground">/mo</span>
          </span>
        </div>
        <CardDescription>
          Get full access to the Shorted API with 10,000 requests per day.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        <ul className="space-y-2 text-sm">
          <li className="flex items-center gap-2">
            <Check className="h-4 w-4 text-green-500 shrink-0" />
            <span>All API endpoints</span>
          </li>
          <li className="flex items-center gap-2">
            <Check className="h-4 w-4 text-green-500 shrink-0" />
            <span>10,000 requests per day</span>
          </li>
          <li className="flex items-center gap-2">
            <Check className="h-4 w-4 text-green-500 shrink-0" />
            <span>Token management</span>
          </li>
          <li className="flex items-center gap-2">
            <Check className="h-4 w-4 text-green-500 shrink-0" />
            <span>Priority support</span>
          </li>
        </ul>

        <Button
          onClick={handleSubscribe}
          disabled={loading}
          className="w-full bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700 text-white"
        >
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
          ) : (
            <CreditCard className="h-4 w-4 mr-2" />
          )}
          Subscribe to Pro
          <ExternalLink className="h-3 w-3 ml-2" />
        </Button>

        {error && <p className="text-xs text-red-500 text-center">{error}</p>}

        <p className="text-[10px] text-center text-muted-foreground">
          Cancel anytime. Secure payment via Stripe.
        </p>
      </CardContent>
    </Card>
  );
}

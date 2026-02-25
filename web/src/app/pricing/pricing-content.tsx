"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { useSubscription } from "~/@/hooks/use-subscription";
import { SUBSCRIPTION_TIERS } from "~/lib/stripe";
import { Button } from "~/@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/@/components/ui/card";
import {
  Check,
  Sparkles,
  Loader2,
  ExternalLink,
  Settings,
} from "lucide-react";
import Link from "next/link";
import { cn } from "~/@/lib/utils";

export function PricingContent() {
  const { data: session, status: authStatus } = useSession();
  const { isPremium, isLoading: subLoading } = useSubscription();
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [portalLoading, setPortalLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isLoading = authStatus === "loading" || subLoading;

  const handleUpgrade = async () => {
    setCheckoutLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/stripe/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier: "premium" }),
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
      setCheckoutLoading(false);
    }
  };

  const handleManageSubscription = async () => {
    setPortalLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/stripe/portal", { method: "POST" });
      const data = (await response.json()) as { url?: string; error?: string };

      if (!response.ok) {
        throw new Error(data.error ?? "Failed to open portal");
      }

      if (data.url) {
        window.location.href = data.url;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setPortalLoading(false);
    }
  };

  const freeFeatures = SUBSCRIPTION_TIERS.free.features;
  const premiumFeatures = SUBSCRIPTION_TIERS.premium.features;

  return (
    <div className="container max-w-4xl py-12 px-4">
      <div className="text-center mb-10">
        <h1 className="text-3xl font-bold tracking-tight">
          Simple, transparent pricing
        </h1>
        <p className="text-muted-foreground mt-2">
          Free to explore. Upgrade for the full experience.
        </p>
      </div>

      <div className="grid md:grid-cols-2 gap-6 max-w-3xl mx-auto">
        {/* Free Tier */}
        <Card className="relative">
          <CardHeader>
            <CardTitle className="text-lg">Free</CardTitle>
            <CardDescription>
              <span className="text-3xl font-bold text-foreground">$0</span>
              <span className="text-muted-foreground"> / forever</span>
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <ul className="space-y-2.5 text-sm">
              {freeFeatures.map((f) => (
                <li key={f} className="flex items-center gap-2">
                  <Check className="h-4 w-4 text-green-500 shrink-0" />
                  <span>{f}</span>
                </li>
              ))}
            </ul>

            {!session ? (
              <Button variant="outline" className="w-full" asChild>
                <Link href="/signup">Get Started Free</Link>
              </Button>
            ) : (
              <Button variant="outline" className="w-full" disabled>
                Current Plan
              </Button>
            )}
          </CardContent>
        </Card>

        {/* Premium Tier */}
        <Card
          className={cn(
            "relative overflow-hidden",
            "border-primary/40 shadow-lg shadow-primary/5"
          )}
        >
          <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-primary via-primary/70 to-primary/40" />
          <CardHeader>
            <div className="flex items-center gap-2">
              <CardTitle className="text-lg">Premium</CardTitle>
              <span className="text-[10px] font-semibold uppercase tracking-wider bg-primary/10 text-primary px-2 py-0.5 rounded-full">
                Popular
              </span>
            </div>
            <CardDescription>
              <span className="text-3xl font-bold text-foreground">$4</span>
              <span className="text-muted-foreground"> / month</span>
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <ul className="space-y-2.5 text-sm">
              {premiumFeatures.map((f) => (
                <li key={f} className="flex items-center gap-2">
                  <Check className="h-4 w-4 text-green-500 shrink-0" />
                  <span>{f}</span>
                </li>
              ))}
            </ul>

            {isLoading ? (
              <Button className="w-full" disabled>
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                Loading...
              </Button>
            ) : isPremium ? (
              <div className="space-y-2">
                <Button
                  variant="outline"
                  className="w-full text-green-600 border-green-600/30"
                  disabled
                >
                  <Check className="h-4 w-4 mr-2" />
                  You&apos;re on Premium
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full text-xs"
                  onClick={handleManageSubscription}
                  disabled={portalLoading}
                >
                  {portalLoading ? (
                    <Loader2 className="h-3 w-3 animate-spin mr-1" />
                  ) : (
                    <Settings className="h-3 w-3 mr-1" />
                  )}
                  Manage Subscription
                </Button>
              </div>
            ) : !session ? (
              <Button className="w-full" asChild>
                <Link href="/signup">
                  <Sparkles className="h-4 w-4 mr-2" />
                  Sign Up & Upgrade
                </Link>
              </Button>
            ) : (
              <Button
                className="w-full"
                onClick={handleUpgrade}
                disabled={checkoutLoading}
              >
                {checkoutLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                ) : (
                  <Sparkles className="h-4 w-4 mr-2" />
                )}
                Upgrade to Premium
                <ExternalLink className="h-3 w-3 ml-2" />
              </Button>
            )}

            {error && (
              <p className="text-xs text-red-500 text-center">{error}</p>
            )}

            <p className="text-[10px] text-center text-muted-foreground">
              Cancel anytime. Secure payment via Stripe.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

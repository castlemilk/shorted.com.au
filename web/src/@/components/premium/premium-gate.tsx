"use client";

import React from "react";
import { useSession } from "next-auth/react";
import { useSubscription } from "~/@/hooks/use-subscription";
import { Lock, Sparkles, Loader2 } from "lucide-react";
import { Button } from "~/@/components/ui/button";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "~/@/lib/utils";

interface PremiumGateProps {
  /** Feature name for display */
  feature: string;
  children: React.ReactNode;
  /** Optional preview content shown behind the blur */
  fallback?: React.ReactNode;
  /** Render as inline overlay (default) or full-page block */
  variant?: "overlay" | "card";
}

export function PremiumGate({
  feature,
  children,
  fallback,
  variant = "overlay",
}: PremiumGateProps) {
  const { data: session, status: authStatus } = useSession();
  const { isPremium, isLoading } = useSubscription();
  const pathname = usePathname();

  // Loading state
  if (authStatus === "loading" || isLoading) {
    if (variant === "card") {
      return (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      );
    }
    return <>{fallback ?? children}</>;
  }

  // Premium users see content normally
  if (session && isPremium) {
    return <>{children}</>;
  }

  // Not signed in
  if (!session) {
    return (
      <GateWrapper variant={variant} fallback={fallback}>
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="p-3 rounded-full bg-muted">
            <Lock className="h-5 w-5 text-muted-foreground" />
          </div>
          <div>
            <p className="font-semibold text-sm">Sign in to unlock {feature}</p>
            <p className="text-xs text-muted-foreground mt-1">
              Create a free account to get started
            </p>
          </div>
          <Button size="sm" asChild>
            <Link href={`/signin?callbackUrl=${encodeURIComponent(pathname)}`}>
              Sign In
            </Link>
          </Button>
        </div>
      </GateWrapper>
    );
  }

  // Signed in but free tier
  return (
    <GateWrapper variant={variant} fallback={fallback}>
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="p-3 rounded-full bg-primary/10">
          <Sparkles className="h-5 w-5 text-primary" />
        </div>
        <div>
          <p className="font-semibold text-sm">Upgrade to Premium</p>
          <p className="text-xs text-muted-foreground mt-1">
            {feature} is available on the Premium plan — $4/mo
          </p>
        </div>
        <Button size="sm" asChild>
          <Link href="/pricing">
            <Sparkles className="h-3.5 w-3.5 mr-1.5" />
            View Plans
          </Link>
        </Button>
      </div>
    </GateWrapper>
  );
}

function GateWrapper({
  variant,
  fallback,
  children,
}: {
  variant: "overlay" | "card";
  fallback?: React.ReactNode;
  children: React.ReactNode;
}) {
  if (variant === "card") {
    return (
      <div className="rounded-lg border border-dashed border-border/60 bg-muted/30 p-8">
        {children}
      </div>
    );
  }

  return (
    <div className="relative">
      {/* Blurred background content */}
      <div className="pointer-events-none select-none blur-[6px] opacity-50" aria-hidden>
        {fallback}
      </div>
      {/* Overlay */}
      <div
        className={cn(
          "absolute inset-0 z-10 flex items-center justify-center",
          "bg-background/60 backdrop-blur-[2px] rounded-lg"
        )}
      >
        {children}
      </div>
    </div>
  );
}

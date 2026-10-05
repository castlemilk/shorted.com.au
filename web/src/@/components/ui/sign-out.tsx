"use client";

import { useRef, useState } from "react";
import { Button } from "~/@/components/ui/button";
import { useToast } from "~/@/hooks/use-toast";
import { signOutFromBrowser } from "~/@/lib/auth-session";

export function SignOut() {
  const { toast } = useToast();
  const pending = useRef(false);
  const [isSigningOut, setIsSigningOut] = useState(false);

  const handleSignOut = async () => {
    if (pending.current) return;
    pending.current = true;
    setIsSigningOut(true);
    try {
      await signOutFromBrowser();
    } catch {
      pending.current = false;
      setIsSigningOut(false);
      toast({
        title: "Could not sign out",
        description: "Please try again.",
        variant: "destructive",
      });
    }
  };

  return (
    <Button
      onClick={handleSignOut}
      disabled={isSigningOut}
      aria-busy={isSigningOut}
      variant="ghost"
      className="w-full justify-start px-3 py-2 text-sm font-medium text-destructive hover:text-destructive hover:bg-destructive/10"
    >
      {isSigningOut ? "Signing out…" : "Sign out"}
    </Button>
  );
}

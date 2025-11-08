"use client";

import { signOut } from "next-auth/react";
import { Button } from "@/components/ui/button";

export function SignOut() {
  const handleSignOut = async () => {
    await signOut({ callbackUrl: "/" });
  };

  return (
    <Button
      onClick={handleSignOut}
      variant="ghost"
      className="w-full justify-start px-2 py-1.5 text-xs font-normal hover:bg-accent hover:text-accent-foreground"
    >
      Sign out
    </Button>
  );
}

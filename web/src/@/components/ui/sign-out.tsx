"use client";

import { signOut } from "next-auth/react";
import { Button } from "~/@/components/ui/button";

export function SignOut() {
  const handleSignOut = async () => {
    await signOut({ callbackUrl: "/" });
  };

  return (
    <Button
      onClick={handleSignOut}
      variant="ghost"
      className="w-full justify-start px-3 py-2 text-sm font-medium text-destructive hover:text-destructive hover:bg-destructive/10"
    >
      Sign out
    </Button>
  );
}

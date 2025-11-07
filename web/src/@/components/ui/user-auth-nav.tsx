"use client";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import Avatar from "@/components/ui/avatar";
import { useSession } from "next-auth/react";
import { SignIn } from "@/components/ui/sign-in";
import { SignOut } from "./sign-out";
import { Skeleton } from "@/components/ui/skeleton";

export const UserAuthNav = () => {
  const { data: session, status } = useSession();
  
  if (status === "loading") {
    return <Skeleton className="h-10 w-10 rounded-full" />;
  }
  
  if (!session) {
    return <SignIn />;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="relative h-10 w-10 rounded-full p-0">
          <Avatar
            name={session?.user?.name ?? "User"}
            picture={session?.user?.image ?? "/default-avatar.png"}
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-56" align="end" forceMount>
        <div className="flex flex-col space-y-1 p-2">
          <p className="text-sm font-medium leading-none">
            {session?.user?.name}
          </p>
          <p className="text-xs leading-none text-muted-foreground">
            {session?.user?.email}
          </p>
        </div>
        <DropdownMenuItem className="p-0 focus:bg-accent">
          <SignOut />
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

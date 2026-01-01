"use client";

import { Button } from "~/@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/@/components/ui/dropdown-menu";
import Avatar from "~/@/components/ui/avatar";
import { useSession } from "next-auth/react";
import { SignIn } from "~/@/components/ui/sign-in";
import { SignOut } from "./sign-out";
import { Skeleton } from "~/@/components/ui/skeleton";
import Link from "next/link";

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
        <Button variant="ghost" className="relative h-9 w-9 rounded-full p-0 border border-border/50 hover:bg-secondary transition-colors">
          <Avatar
            name={session?.user?.name ?? "User"}
            picture={session?.user?.image ?? "/default-avatar.png"}
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-56 mt-2" align="end" forceMount>
        <div className="flex flex-col space-y-1 p-3 border-b border-border/50">
          <p className="text-sm font-bold leading-none truncate">
            {session?.user?.name}
          </p>
          <p className="text-xs leading-none text-muted-foreground truncate">
            {session?.user?.email}
          </p>
        </div>
        <div className="p-1">
          <DropdownMenuItem asChild className="cursor-pointer focus:bg-secondary">
            <Link href="/portfolio" className="w-full">My Portfolio</Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild className="cursor-pointer focus:bg-secondary">
            <Link href="/dashboards" className="w-full">Dashboards</Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild className="cursor-pointer focus:bg-secondary text-blue-500 font-medium">
            <Link href="/docs/api" className="w-full">API Documentation</Link>
          </DropdownMenuItem>
          {session?.user?.isAdmin && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild className="cursor-pointer focus:bg-secondary text-purple-500 font-medium">
                <Link href="/admin" className="w-full">Admin: Sync Status</Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild className="cursor-pointer focus:bg-secondary text-purple-500 font-medium">
                <Link href="/admin/enrichments" className="w-full">Admin: Enrichments</Link>
              </DropdownMenuItem>
            </>
          )}
        </div>
        <div className="p-1 border-t border-border/50">
          <DropdownMenuItem className="p-0 focus:bg-destructive/10">
            <SignOut />
          </DropdownMenuItem>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

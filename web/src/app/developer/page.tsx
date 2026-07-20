"use client";

import { useSession } from "next-auth/react";
import { pageTitle } from "~/@/lib/typography";
import { Loader2 } from "lucide-react";
import Image from "next/image";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { ApiKeyManager } from "~/@/components/api-key-manager";

function DeveloperLoadingState() {
  return (
    <div className="flex items-center justify-center h-64">
      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
    </div>
  );
}

export default function DeveloperPage() {
  const { data: session, status } = useSession();

  if (status === "loading" || !session) {
    return (
      <DashboardLayout>
        <DeveloperLoadingState />
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="max-w-3xl mx-auto space-y-6">
        <div className="flex items-center gap-4">
          <Image src="/assets/api-access-small.png" alt="" width={48} height={48} className="h-12 w-12" />
          <div>
            <h1 className={pageTitle}>Developer</h1>
            <p className="text-muted-foreground mt-1">
              Manage your API tokens and view rate limit information.
            </p>
          </div>
        </div>
        <ApiKeyManager />
      </div>
    </DashboardLayout>
  );
}

"use client";

import dynamic from "next/dynamic";
import { Skeleton } from "~/@/components/ui/skeleton";

// Dynamically import RegisterEmail to avoid SSR issues with protobuf imports
const RegisterEmail = dynamic(
  () => import("~/@/components/ui/register-email"),
  {
    ssr: false,
    loading: () => (
      <div className="bg-gray-800 p-6 rounded-lg">
        <Skeleton className="h-32 w-full rounded-lg" />
      </div>
    ),
  }
);

export default function RegisterEmailClient(props: Record<string, unknown>) {
  return <RegisterEmail {...props} />;
}

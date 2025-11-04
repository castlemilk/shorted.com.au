import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { LogIn } from "lucide-react";
import Link from "next/link";

interface LoginRequiredProps {
  title?: string;
  description?: string;
}

export function LoginRequired({
  title = "Sign in Required",
  description = "Please sign in to access this page",
}: LoginRequiredProps) {
  return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <Card className="p-8 text-center max-w-md">
        <div className="mb-4 flex justify-center">
          <div className="rounded-full bg-muted p-3">
            <LogIn className="h-6 w-6 text-muted-foreground" />
          </div>
        </div>
        <h2 className="text-xl font-semibold mb-2">{title}</h2>
        <p className="text-muted-foreground mb-6">{description}</p>
        <Button asChild className="w-full">
          <Link href="/signin">Sign In</Link>
        </Button>
      </Card>
    </div>
  );
}

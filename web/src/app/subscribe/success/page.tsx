import { Suspense } from "react";
import Link from "next/link";
import { CheckCircle, ArrowRight, Sparkles, MessageSquare, Activity, Bell, LayoutDashboard } from "lucide-react";
import Image from "next/image";
import { Button } from "~/@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/@/components/ui/card";

function SuccessContent() {
  return (
    <div className="container max-w-2xl py-20">
      <Card className="border-primary/30">
        <CardHeader className="text-center pb-2">
          <div className="mx-auto mb-4">
            <Image src="/assets/premium-icon-small.png" alt="" width={64} height={64} className="h-16 w-16" />
          </div>
          <CardTitle className="text-2xl">Welcome to Premium!</CardTitle>
          <CardDescription className="text-base">
            Your Shorted Premium subscription is now active.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="rounded-lg bg-muted p-4 space-y-3">
            <h3 className="font-semibold flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" />
              What&apos;s included in Premium
            </h3>
            <ul className="text-sm text-muted-foreground space-y-2">
              <li className="flex items-center gap-2">
                <MessageSquare className="h-4 w-4 text-lime-700 dark:text-lime-300" />
                AI Chat assistant
              </li>
              <li className="flex items-center gap-2">
                <Activity className="h-4 w-4 text-lime-700 dark:text-lime-300" />
                Market Pulse dashboard
              </li>
              <li className="flex items-center gap-2">
                <Bell className="h-4 w-4 text-lime-700 dark:text-lime-300" />
                Price &amp; position alerts
              </li>
              <li className="flex items-center gap-2">
                <LayoutDashboard className="h-4 w-4 text-lime-700 dark:text-lime-300" />
                Advanced dashboard widgets
              </li>
              <li className="flex items-center gap-2">
                <CheckCircle className="h-4 w-4 text-lime-700 dark:text-lime-300" />
                Priority support
              </li>
            </ul>
          </div>

          <div className="flex flex-col gap-3">
            <Button asChild className="w-full">
              <Link href="/docs/api" className="flex items-center justify-center gap-2">
                <Image src="/assets/api-access-small.png" alt="" width={16} height={16} className="h-4 w-4" />
                Generate Your API Key
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
            <Button asChild variant="outline" className="w-full">
              <Link href="/">Return to Home</Link>
            </Button>
          </div>

          <p className="text-xs text-center text-muted-foreground">
            Your subscription will renew automatically. You can manage your subscription
            from the pricing page at any time.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

export default function SubscribeSuccessPage() {
  return (
    <Suspense fallback={
      <div className="container max-w-2xl py-20 flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Loading...</div>
      </div>
    }>
      <SuccessContent />
    </Suspense>
  );
}

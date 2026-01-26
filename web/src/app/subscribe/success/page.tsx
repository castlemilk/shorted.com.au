import { Suspense } from "react";
import Link from "next/link";
import { CheckCircle, ArrowRight, Key, Sparkles } from "lucide-react";
import { Button } from "~/@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/@/components/ui/card";

function SuccessContent() {
  return (
    <div className="container max-w-2xl py-20">
      <Card className="border-green-500/20 shadow-lg shadow-green-500/5">
        <CardHeader className="text-center pb-2">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-green-500/10">
            <CheckCircle className="h-10 w-10 text-green-500" />
          </div>
          <CardTitle className="text-2xl">Payment Successful!</CardTitle>
          <CardDescription className="text-base">
            Welcome to Shorted Pro. Your API access is now active.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="rounded-lg bg-zinc-100 dark:bg-zinc-900 p-4 space-y-3">
            <h3 className="font-semibold flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-yellow-500" />
              What&apos;s included in Pro
            </h3>
            <ul className="text-sm text-muted-foreground space-y-2">
              <li className="flex items-center gap-2">
                <CheckCircle className="h-4 w-4 text-green-500" />
                Access to all API endpoints
              </li>
              <li className="flex items-center gap-2">
                <CheckCircle className="h-4 w-4 text-green-500" />
                10,000 requests per day
              </li>
              <li className="flex items-center gap-2">
                <CheckCircle className="h-4 w-4 text-green-500" />
                Token management
              </li>
              <li className="flex items-center gap-2">
                <CheckCircle className="h-4 w-4 text-green-500" />
                Priority support
              </li>
            </ul>
          </div>

          <div className="flex flex-col gap-3">
            <Button asChild className="w-full bg-blue-600 hover:bg-blue-700">
              <Link href="/docs/api" className="flex items-center justify-center gap-2">
                <Key className="h-4 w-4" />
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
            from the API documentation page at any time.
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

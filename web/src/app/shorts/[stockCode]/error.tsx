"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { AlertTriangle, RefreshCw, Home, TrendingDown } from "lucide-react";
import Link from "next/link";

interface StockErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function StockError({ error, reset }: StockErrorProps) {
  useEffect(() => {
    // Log the error to console in development
    console.error("Stock page error:", error);
    console.error("Error digest:", error?.digest);
  }, [error]);

  // Extract stock code from URL if possible
  const stockCode =
    typeof window !== "undefined"
      ? window.location.pathname.split("/").pop()?.toUpperCase()
      : "this stock";

  return (
    <div className="container mx-auto px-4 py-8 max-w-2xl">
      <Card className="border-l-4 border-l-amber-500">
        <CardHeader className="pb-4">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-amber-100 dark:bg-amber-900/40 rounded-lg">
              <AlertTriangle className="h-6 w-6 text-amber-600 dark:text-amber-400" />
            </div>
            <div>
              <CardTitle className="text-xl text-amber-900 dark:text-amber-100">
                Unable to Load Stock Data
              </CardTitle>
              <CardDescription className="mt-1">
                We couldn&apos;t load the data for {stockCode}
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            This could happen for a few reasons:
          </p>
          <ul className="text-sm text-muted-foreground list-disc list-inside space-y-1">
            <li>The stock code may not exist or has been delisted</li>
            <li>Our servers are temporarily experiencing high load</li>
            <li>There&apos;s a temporary network issue</li>
            <li>The stock data is still being synced (new listings)</li>
          </ul>

          <div className="flex flex-col sm:flex-row gap-3 pt-4">
            <Button onClick={reset} className="flex items-center gap-2">
              <RefreshCw className="h-4 w-4" />
              Try Again
            </Button>
            <Button
              variant="outline"
              asChild
              className="flex items-center gap-2"
            >
              <Link href="/shorts">
                <TrendingDown className="h-4 w-4" />
                View Top Shorts
              </Link>
            </Button>
            <Button variant="ghost" asChild className="flex items-center gap-2">
              <Link href="/">
                <Home className="h-4 w-4" />
                Go Home
              </Link>
            </Button>
          </div>

          {process.env.NODE_ENV === "development" && error?.message && (
            <div className="mt-6 p-4 bg-muted rounded-lg">
              <p className="text-xs font-mono text-muted-foreground break-all">
                Debug: {error.message}
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

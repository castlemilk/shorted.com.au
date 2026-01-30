import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Search, TrendingDown, Home } from "lucide-react";
import Link from "next/link";

export default function StockNotFound() {
  return (
    <div className="container mx-auto px-4 py-8 max-w-2xl">
      <Card className="border-l-4 border-l-blue-500">
        <CardHeader className="pb-4">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-blue-100 dark:bg-blue-900/40 rounded-lg">
              <Search className="h-6 w-6 text-blue-600 dark:text-blue-400" />
            </div>
            <div>
              <CardTitle className="text-xl text-blue-900 dark:text-blue-100">
                Stock Not Found
              </CardTitle>
              <CardDescription className="mt-1">
                We couldn&apos;t find this stock in our database
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            The stock code you&apos;re looking for doesn&apos;t appear to exist
            in our database. This could mean:
          </p>
          <ul className="text-sm text-muted-foreground list-disc list-inside space-y-1">
            <li>The stock code was entered incorrectly</li>
            <li>The stock has been delisted from the ASX</li>
            <li>The stock has no reported short positions</li>
            <li>
              It&apos;s a very new listing that hasn&apos;t been indexed yet
            </li>
          </ul>

          <div className="flex flex-col sm:flex-row gap-3 pt-4">
            <Button asChild className="flex items-center gap-2">
              <Link href="/shorts">
                <TrendingDown className="h-4 w-4" />
                View Top Shorts
              </Link>
            </Button>
            <Button
              variant="outline"
              asChild
              className="flex items-center gap-2"
            >
              <Link href="/stocks">
                <Search className="h-4 w-4" />
                Search Stocks
              </Link>
            </Button>
            <Button variant="ghost" asChild className="flex items-center gap-2">
              <Link href="/">
                <Home className="h-4 w-4" />
                Go Home
              </Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

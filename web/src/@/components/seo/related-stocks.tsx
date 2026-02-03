import Link from "next/link";
import { TrendingDown, ChevronRight } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/@/components/ui/card";
import { Badge } from "~/@/components/ui/badge";
import { cn } from "~/@/lib/utils";

export interface RelatedStock {
  code: string;
  name: string;
  shortPercent: number;
  industry: string;
}

interface RelatedStocksProps {
  stocks: RelatedStock[];
  currentStock?: string;
  industrySlug?: string | null;
  title?: string;
  description?: string;
  className?: string;
}

/**
 * Component to display related stocks by industry for internal linking.
 * Improves SEO by creating contextual links between stock pages.
 */
export function RelatedStocks({
  stocks,
  currentStock,
  industrySlug,
  title = "Related Stocks",
  description = "Other stocks in the same industry",
  className,
}: RelatedStocksProps) {
  // Filter out the current stock and take top 5
  const relatedStocks = stocks
    .filter((s) => s.code !== currentStock)
    .slice(0, 5);

  if (relatedStocks.length === 0) {
    return null;
  }

  return (
    <Card className={cn("", className)}>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg flex items-center gap-2">
          <TrendingDown className="h-5 w-5 text-red-500" />
          {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {relatedStocks.map((stock) => (
            <Link
              key={stock.code}
              href={`/shorts/${stock.code}`}
              className="flex items-center justify-between p-3 rounded-lg border border-border/60 hover:border-primary/50 hover:bg-muted/50 transition-all group"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-semibold group-hover:text-primary transition-colors">
                    {stock.code}
                  </span>
                  <ShortBadge percent={stock.shortPercent} />
                </div>
                <div className="text-xs text-muted-foreground truncate mt-0.5">
                  {stock.name}
                </div>
              </div>
              <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors flex-shrink-0" />
            </Link>
          ))}
        </div>

        {stocks.length > 5 && industrySlug && (
          <Link
            href={`/industry/${industrySlug}`}
            className="mt-4 text-sm text-primary hover:underline flex items-center gap-1"
          >
            View all stocks in this industry
            <ChevronRight className="h-3 w-3" />
          </Link>
        )}
      </CardContent>
    </Card>
  );
}

function ShortBadge({ percent }: { percent: number }) {
  const getVariant = (pct: number) => {
    if (pct >= 15) return "destructive";
    if (pct >= 10) return "default";
    return "secondary";
  };

  return (
    <Badge variant={getVariant(percent)} className="text-xs">
      {percent.toFixed(1)}%
    </Badge>
  );
}


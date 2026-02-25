import { Badge } from "~/@/components/ui/badge";
import { cn } from "~/@/lib/utils";

interface SentimentBadgeProps {
  sentiment: string;
  className?: string;
}

const sentimentStyles: Record<string, string> = {
  positive:
    "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-400",
  negative:
    "bg-red-100 text-red-800 dark:bg-red-950/30 dark:text-red-400",
  neutral:
    "bg-gray-100 text-gray-700 dark:bg-gray-800/30 dark:text-gray-400",
};

export function SentimentBadge({ sentiment, className }: SentimentBadgeProps) {
  const style = sentimentStyles[sentiment] ?? sentimentStyles.neutral;

  return (
    <Badge variant="outline" className={cn("text-xs font-medium border-0", style, className)}>
      {sentiment}
    </Badge>
  );
}

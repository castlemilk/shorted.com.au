import { Badge } from "~/@/components/ui/badge";
import { cn } from "~/@/lib/utils";

interface SentimentBadgeProps {
  sentiment: string;
  className?: string;
}

const sentimentStyles: Record<string, string> = {
  positive:
    "bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-400 dark:border-emerald-800",
  negative:
    "bg-red-100 text-red-800 border-red-200 dark:bg-red-950/30 dark:text-red-400 dark:border-red-800",
  neutral:
    "bg-muted text-muted-foreground border-border",
};

const sentimentLabels: Record<string, string> = {
  positive: "Positive",
  negative: "Negative",
  neutral: "Neutral",
};

/** Visible label: mapped for known sentiments, capitalized for unknown ones. */
function sentimentLabel(sentiment: string): string {
  const mapped = sentimentLabels[sentiment];
  if (mapped) return mapped;
  if (!sentiment) return "Neutral";
  return sentiment.charAt(0).toUpperCase() + sentiment.slice(1);
}

export function SentimentBadge({ sentiment, className }: SentimentBadgeProps) {
  const style = sentimentStyles[sentiment] ?? sentimentStyles.neutral;

  return (
    <Badge
      variant="outline"
      className={cn("rounded-full text-xs font-medium", style, className)}
    >
      {sentimentLabel(sentiment)}
    </Badge>
  );
}

import { Clock3, MessageCircleMore } from "lucide-react";
import { type CommunityPulseItem } from "~/@/types/community";
import { Badge } from "~/@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "~/@/components/ui/card";
import { CommunityFeedbackActions } from "./community-feedback-actions";
import { CommunityEmptyState } from "./community-empty-state";

interface CommunityPulseRailProps {
  pulse: CommunityPulseItem[];
}

function formatPulseTime(value: Date): string {
  return value.toLocaleTimeString("en-AU", {
    hour: "numeric",
    minute: "2-digit",
  });
}

export function CommunityPulseRail({ pulse }: CommunityPulseRailProps) {
  return (
    <aside className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-xl font-semibold text-foreground">Live Pulse</h2>
        <p className="text-sm leading-6 text-muted-foreground">
          Short-form reactions for fresh headlines, flow, and crowd temperature.
        </p>
      </div>

      {pulse.length === 0 ? (
        <CommunityEmptyState
          eyebrow="Quiet tape"
          title="No pulse updates yet"
          description="When something moves, this rail should light up first."
        />
      ) : (
        <div className="space-y-3">
          {pulse.map((item) => (
            <Card key={item.id} className="border-border/70 bg-card/90 shadow-sm">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between gap-3">
                  <CardTitle className="text-sm font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                    Market pulse
                  </CardTitle>
                  <Badge variant="secondary">{item.score} score</Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-sm leading-6 text-foreground">{item.body}</p>
                <div className="flex flex-wrap items-center gap-4 text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                  <span className="inline-flex items-center gap-1.5">
                    <Clock3 className="h-3.5 w-3.5" />
                    {formatPulseTime(item.createdAt)}
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <MessageCircleMore className="h-3.5 w-3.5" />
                    {item.replyCount} replies
                  </span>
                </div>
                <CommunityFeedbackActions
                  stockCode={item.stockCode}
                  targetType="pulse"
                  targetId={item.id}
                  initialScore={item.score}
                />
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </aside>
  );
}

import Link from "next/link";
import { ArrowUpRight, Files, MessageSquare } from "lucide-react";
import { type CommunityThread } from "~/@/types/community";
import { Badge } from "~/@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "~/@/components/ui/card";

interface CommunityThreadCardProps {
  thread: CommunityThread;
}

export function CommunityThreadCard({ thread }: CommunityThreadCardProps) {
  return (
    <Card className="border-border/70 bg-card/90 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md">
      <CardHeader className="space-y-3 pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary" className="uppercase tracking-[0.16em]">
            {thread.type.replace("_", " ")}
          </Badge>
          {thread.highSignal ? (
            <Badge variant="secondary" className="bg-amber-100 text-amber-950 dark:bg-amber-900/40 dark:text-amber-100">
              High signal
            </Badge>
          ) : null}
        </div>
        <div className="space-y-2">
          <CardTitle className="text-lg leading-tight">
            <Link
              href={`/shorts/${thread.stockCode}/community/${thread.id}`}
              className="inline-flex items-start gap-2 hover:text-primary"
            >
              <span>{thread.title}</span>
              <ArrowUpRight className="mt-0.5 h-4 w-4 shrink-0" />
            </Link>
          </CardTitle>
          <p className="text-sm leading-6 text-muted-foreground">
            {thread.body}
          </p>
        </div>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
        <span className="font-medium text-foreground">{thread.score} score</span>
        <span className="inline-flex items-center gap-1.5">
          <MessageSquare className="h-4 w-4" />
          {thread.commentCount} comments
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Files className="h-4 w-4" />
          {thread.sourceCount} sources
        </span>
      </CardContent>
    </Card>
  );
}

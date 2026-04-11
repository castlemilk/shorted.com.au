import Link from "next/link";
import { type CommunityComment, type CommunityThread } from "~/@/types/community";
import { Button } from "~/@/components/ui/button";
import { Badge } from "~/@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "~/@/components/ui/card";
import { CommunityCommentList } from "./community-comment-list";

interface CommunityThreadDetailProps {
  thread: CommunityThread;
  comments: CommunityComment[];
}

export function CommunityThreadDetail({
  thread,
  comments,
}: CommunityThreadDetailProps) {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button variant="outline" asChild>
          <Link href={`/shorts/${thread.stockCode}?tab=community`}>
            Back to {thread.stockCode} community
          </Link>
        </Button>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled>
            Vote soon
          </Button>
          <Button variant="outline" disabled>
            Report soon
          </Button>
        </div>
      </div>

      <Card className="border-border/70 shadow-lg">
        <CardHeader className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary" className="uppercase tracking-[0.16em]">
              {thread.type.replace("_", " ")}
            </Badge>
            {thread.highSignal ? (
              <Badge variant="secondary">High signal</Badge>
            ) : null}
          </div>
          <div className="space-y-3">
            <CardTitle className="text-2xl leading-tight">
              {thread.title}
            </CardTitle>
            <p className="text-sm leading-7 text-muted-foreground">
              {thread.body}
            </p>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          {thread.sources && thread.sources.length > 0 ? (
            <div className="space-y-3">
              <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                Sources
              </h2>
              <div className="flex flex-col gap-2">
                {thread.sources.map((source) => (
                  <Link
                    key={source.url}
                    href={source.url}
                    className="text-sm font-medium text-primary hover:underline"
                  >
                    {source.label}
                  </Link>
                ))}
              </div>
            </div>
          ) : null}

          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-xl font-semibold text-foreground">Comments</h2>
              <span className="text-sm text-muted-foreground">
                {comments.length} replies
              </span>
            </div>
            <CommunityCommentList comments={comments} />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

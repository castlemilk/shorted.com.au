import { type CommunityComment } from "~/@/types/community";
import { CommunityEmptyState } from "./community-empty-state";

interface CommunityCommentListProps {
  comments: CommunityComment[];
}

export function CommunityCommentList({
  comments,
}: CommunityCommentListProps) {
  if (comments.length === 0) {
    return (
      <CommunityEmptyState
        eyebrow="No replies yet"
        title="No comments yet"
        description="The first reply should sharpen the thesis, challenge it, or add evidence."
      />
    );
  }

  return (
    <div className="space-y-3">
      {comments.map((comment) => (
        <div
          key={comment.id}
          className="rounded-xl border border-border/70 bg-background/80 p-4 shadow-sm"
        >
          <p className="text-sm leading-6 text-foreground">{comment.body}</p>
          <div className="mt-3 text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
            {comment.score} score
          </div>
        </div>
      ))}
    </div>
  );
}

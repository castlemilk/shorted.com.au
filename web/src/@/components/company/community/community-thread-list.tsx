import { type CommunityThread } from "~/@/types/community";
import { CommunityThreadCard } from "./community-thread-card";
import { CommunityEmptyState } from "./community-empty-state";

interface CommunityThreadListProps {
  stockCode: string;
  threads: CommunityThread[];
}

export function CommunityThreadList({
  stockCode,
  threads,
}: CommunityThreadListProps) {
  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-xl font-semibold text-foreground">
          Research Threads
        </h2>
        <p className="text-sm leading-6 text-muted-foreground">
          Bull, bear, catalyst, and news-reaction posts tied directly to {stockCode}.
        </p>
      </div>

      {threads.length === 0 ? (
        <CommunityEmptyState
          eyebrow="No threads yet"
          title={`Start the first ${stockCode} research thread`}
          description="Anchor the conversation with a thesis, a catalyst, or a question worth debating."
        />
      ) : (
        <div className="space-y-4">
          {threads.map((thread) => (
            <CommunityThreadCard key={thread.id} thread={thread} />
          ))}
        </div>
      )}
    </section>
  );
}

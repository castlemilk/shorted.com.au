"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import {
  type PublicCommunityComment,
  type PublicCommunityThread,
} from "~/@/types/community";
import { stockTabHref } from "~/@/lib/stocks/stock-tabs";
import { safeExternalHref } from "~/@/lib/safe-external-href";
import { Button } from "~/@/components/ui/button";
import { Badge } from "~/@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "~/@/components/ui/card";
import { CommunityCommentForm } from "./community-comment-form";
import { CommunityCommentList } from "./community-comment-list";
import { CommunityFeedbackActions } from "./community-feedback-actions";

interface CommunityThreadDetailProps {
  thread: PublicCommunityThread;
  comments: PublicCommunityComment[];
}

interface LocalComment {
  comment: PublicCommunityComment;
  viewerId: string;
  persistedComments: PublicCommunityComment[];
}

function isVisibleLocalComment(
  local: LocalComment,
  comments: PublicCommunityComment[],
  viewerId: string | undefined,
  threadId: string,
  stockCode: string,
) {
  return (
    local.viewerId === viewerId &&
    local.comment.threadId === threadId &&
    local.comment.stockCode === stockCode &&
    !comments.some((comment) => comment.id === local.comment.id) &&
    (local.comment.status === "needs_review" ||
      (local.comment.status === "active" &&
        local.persistedComments === comments))
  );
}

export function CommunityThreadDetail({
  thread,
  comments,
}: CommunityThreadDetailProps) {
  const { data: session } = useSession();
  const viewerId = session?.user?.id;
  const [localComments, setLocalComments] = useState<LocalComment[]>([]);
  // Server data always wins on refresh. Local POST responses are scoped at
  // render time so a delayed response from a previous viewer cannot appear
  // after sign-out/account switching, even before an effect has run.
  const commentItems = [
    ...comments,
    ...localComments
      .filter((local) =>
        isVisibleLocalComment(
          local,
          comments,
          viewerId,
          thread.id,
          thread.stockCode,
        ),
      )
      .map(({ comment }) => comment),
  ];

  useEffect(() => {
    setLocalComments((current) => {
      const retained = current.filter((local) =>
        isVisibleLocalComment(
          local,
          comments,
          viewerId,
          thread.id,
          thread.stockCode,
        ),
      );
      return retained.length === current.length ? current : retained;
    });
  }, [comments, thread.id, thread.stockCode, viewerId]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button variant="outline" asChild>
          <Link
            href={stockTabHref(thread.stockCode, "community")}
            prefetch={false}
          >
            Back to {thread.stockCode} community
          </Link>
        </Button>
        <CommunityFeedbackActions
          stockCode={thread.stockCode}
          targetType="thread"
          targetId={thread.id}
          initialScore={thread.score}
        />
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
                {/* A source is whatever its author typed: a link only when
                    it is an http(s) URL, otherwise just its label. */}
                {thread.sources.map((source) => {
                  const href = safeExternalHref(source.url);
                  return href ? (
                    <a
                      key={source.url}
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer nofollow ugc"
                      className="text-sm font-medium text-primary hover:underline"
                    >
                      {source.label}
                    </a>
                  ) : (
                    <span key={source.url} className="text-sm font-medium">
                      {source.label}
                    </span>
                  );
                })}
              </div>
            </div>
          ) : null}

          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-xl font-semibold text-foreground">
                Comments
              </h2>
              <span className="text-sm text-muted-foreground">
                {commentItems.length} replies
              </span>
            </div>
            {session?.user?.id ? (
              <CommunityCommentForm
                stockCode={thread.stockCode}
                threadId={thread.id}
                onCreated={(comment) => {
                  if (!viewerId) return;
                  setLocalComments((current) => [
                    ...current.filter(
                      (local) => local.comment.id !== comment.id,
                    ),
                    { comment, viewerId, persistedComments: comments },
                  ]);
                }}
              />
            ) : (
              <Link
                href={`/signin?callbackUrl=${encodeURIComponent(
                  `/shorts/${thread.stockCode}/community/${thread.id}`,
                )}`}
                className="inline-flex items-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium hover:bg-accent"
              >
                Sign in to reply
              </Link>
            )}
            <CommunityCommentList comments={commentItems} />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

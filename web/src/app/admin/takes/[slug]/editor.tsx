"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ChatMarkdown } from "~/@/components/chat/chat-markdown";
import { publishTake, deleteTake, updateTake } from "~/app/actions/admin/takes";

interface TakeJSON {
  id: string;
  slug: string;
  headline: string;
  stockCode?: string;
  bodyMd: string;
  sentiment?: string;
  sourceUrl?: string;
  sourceName?: string;
  heroImageUrl?: string;
  wordCount?: number;
  publishedAt?: number | null;
  tweetPublishedAt?: number | null;
}

export function AdminTakeEditor({ takeJSON }: { takeJSON: string }) {
  const initial = JSON.parse(takeJSON) as TakeJSON;
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [headline, setHeadline] = useState(initial.headline);
  const [bodyMd, setBodyMd] = useState(initial.bodyMd);
  const [editing, setEditing] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [heroUrl, setHeroUrl] = useState(initial.heroImageUrl);

  const isPublished = !!initial.publishedAt;
  const isTweeted = !!initial.tweetPublishedAt;
  const slug = initial.slug;

  const wordCount = bodyMd.split(/\s+/).filter(Boolean).length;
  const dirty = headline !== initial.headline || bodyMd !== initial.bodyMd;

  const handleSave = () => {
    setError(null);
    startTransition(async () => {
      try {
        await updateTake(slug, { headline, bodyMd });
        setEditing(false);
        router.refresh();
      } catch (e) {
        setError(String((e as Error).message ?? e));
      }
    });
  };

  const handlePublish = () => {
    if (!confirm("Publish this take? It will appear on /news/" + slug + " and be queued for tweeting.")) return;
    setError(null);
    startTransition(async () => {
      try {
        await publishTake(slug);
        router.refresh();
      } catch (e) {
        setError(String((e as Error).message ?? e));
      }
    });
  };

  const handleDelete = () => {
    if (!confirm("Delete this take? This cannot be undone.")) return;
    setError(null);
    startTransition(async () => {
      try {
        await deleteTake(slug);
        router.push("/admin/takes");
      } catch (e) {
        setError(String((e as Error).message ?? e));
      }
    });
  };

  const handleRegenHero = async () => {
    if (!confirm("Generate a new hero image? This costs ~$0.075 and takes ~30s.")) return;
    setRegenerating(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/regen-hero?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(`HTTP ${res.status}: ${t.slice(0, 200)}`);
      }
      const data = (await res.json()) as { heroImageUrl?: string };
      if (data.heroImageUrl) setHeroUrl(data.heroImageUrl);
      router.refresh();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setRegenerating(false);
    }
  };

  return (
    <div>
      {/* Status row */}
      <div className="mb-4 flex items-center gap-2">
        {isTweeted ? (
          <Badge color="emerald">Tweeted</Badge>
        ) : isPublished ? (
          <Badge color="blue">Published — awaiting tweet (≤5 min)</Badge>
        ) : (
          <Badge color="amber">Draft</Badge>
        )}
        {initial.stockCode ? (
          <span className="font-mono text-sm text-orange-300">${initial.stockCode}</span>
        ) : null}
        <span className="ml-auto text-xs text-muted-foreground">{wordCount} words</span>
      </div>

      {/* Hero */}
      {heroUrl ? (
        <figure className="mb-6 overflow-hidden rounded-lg border border-border">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={heroUrl} alt={headline} className="h-auto w-full" />
        </figure>
      ) : (
        <div className="mb-6 rounded-lg border border-dashed border-border bg-muted/20 p-8 text-center text-sm text-muted-foreground">
          No hero image. Generate one below.
        </div>
      )}

      {/* Headline */}
      {editing ? (
        <input
          value={headline}
          onChange={(e) => setHeadline(e.target.value)}
          className="mb-4 w-full rounded border border-border bg-background px-3 py-2 text-2xl font-bold"
          placeholder="Headline"
        />
      ) : (
        <h1 className="mb-4 text-2xl font-bold leading-tight md:text-3xl">{headline}</h1>
      )}

      {/* Body */}
      {editing ? (
        <textarea
          value={bodyMd}
          onChange={(e) => setBodyMd(e.target.value)}
          rows={18}
          className="mb-4 w-full rounded border border-border bg-background px-3 py-3 font-mono text-sm"
        />
      ) : (
        <article className="mb-6">
          <ChatMarkdown content={bodyMd} />
        </article>
      )}

      {/* Source */}
      {initial.sourceUrl ? (
        <div className="mb-6 rounded border border-border bg-muted/20 p-3 text-sm">
          Source:{" "}
          <a href={initial.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-orange-400 hover:text-orange-300">
            {initial.sourceName ?? initial.sourceUrl}
          </a>
        </div>
      ) : null}

      {/* Error surface */}
      {error ? (
        <div className="mb-4 rounded border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300">{error}</div>
      ) : null}

      {/* Action bar */}
      <div className="sticky bottom-4 flex flex-wrap gap-2 rounded-lg border border-border bg-card/95 p-3 backdrop-blur">
        {editing ? (
          <>
            <button
              onClick={handleSave}
              disabled={pending || !dirty}
              className="rounded bg-orange-500 px-4 py-2 text-sm font-medium text-black hover:bg-orange-400 disabled:opacity-50"
            >
              {pending ? "Saving…" : "Save"}
            </button>
            <button
              onClick={() => {
                setEditing(false);
                setHeadline(initial.headline);
                setBodyMd(initial.bodyMd);
              }}
              disabled={pending}
              className="rounded border border-border px-4 py-2 text-sm hover:bg-muted"
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            onClick={() => setEditing(true)}
            disabled={pending}
            className="rounded border border-border px-4 py-2 text-sm hover:bg-muted"
          >
            Edit
          </button>
        )}
        <button
          onClick={handleRegenHero}
          disabled={pending || regenerating}
          className="rounded border border-border px-4 py-2 text-sm hover:bg-muted disabled:opacity-50"
        >
          {regenerating ? "Generating… (~30s)" : "Regenerate hero"}
        </button>
        <div className="flex-1" />
        {!isPublished ? (
          <button
            onClick={handlePublish}
            disabled={pending}
            className="rounded bg-emerald-500 px-4 py-2 text-sm font-medium text-black hover:bg-emerald-400 disabled:opacity-50"
          >
            {pending ? "Publishing…" : "Publish"}
          </button>
        ) : null}
        <button
          onClick={handleDelete}
          disabled={pending}
          className="rounded border border-red-500/40 px-4 py-2 text-sm text-red-400 hover:bg-red-500/10 disabled:opacity-50"
        >
          Delete
        </button>
      </div>
    </div>
  );
}

function Badge({ color, children }: { color: "emerald" | "blue" | "amber"; children: React.ReactNode }) {
  const classes = {
    emerald: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
    blue: "bg-blue-500/10 text-blue-400 border-blue-500/30",
    amber: "bg-amber-500/10 text-amber-400 border-amber-500/30",
  }[color];
  return <span className={`inline-flex rounded border px-2 py-0.5 text-xs font-medium ${classes}`}>{children}</span>;
}

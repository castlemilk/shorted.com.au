"use client";

import Link from "next/link";
import { useMemo, useState, useSyncExternalStore } from "react";

import { AUSTRALIAN_INVESTORS_PATH } from "~/@/lib/ownership/australian-investors";
import { REGISTER_CODE_PATTERN } from "~/@/lib/ownership/kinds";
import { safeExternalHref } from "~/@/lib/safe-external-href";
import { filerId } from "~/@/lib/ownership/named-filer";

import type { SavedInvestor } from "~/@/lib/ownership/investor-activity";

const empty = () => "[]";
function listStorage(key: string) {
  const snapshot = () => {
    try {
      return window.localStorage.getItem(key) ?? empty();
    } catch {
      return empty();
    }
  };
  function subscribe(update: () => void) {
    const sync = (event: StorageEvent) => {
      if (event.key === null || event.key === key) update();
    };
    window.addEventListener("storage", sync);
    window.addEventListener(key, update);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(key, update);
    };
  }
  function update(
    change: (raw: string) => unknown[],
    setError: (failed: boolean) => void,
  ) {
    const commit = () => {
      try {
        const values = change(window.localStorage.getItem(key) ?? empty());
        window.localStorage.setItem(key, JSON.stringify(values));
        window.dispatchEvent(new Event(key));
        setError(false);
      } catch {
        setError(true);
      }
    };
    // Two open tabs may update different notices from the same stored list.
    if (navigator.locks?.request) {
      void navigator.locks.request(key, commit).catch(() => setError(true));
    } else {
      commit();
    }
  }
  return { snapshot, subscribe, update };
}
const follows = listStorage("shorted:ownership:followed-asx-investors:v1");
const readNotices = listStorage("shorted:ownership:read-asx-notices:v1");

function readIds(raw: string): Set<string> {
  try {
    const values: unknown = JSON.parse(raw);
    return new Set(
      Array.isArray(values)
        ? values.filter((v): v is string => typeof v === "string")
        : [],
    );
  } catch {
    return new Set();
  }
}

export function useReadFilings() {
  const raw = useSyncExternalStore(
    readNotices.subscribe,
    readNotices.snapshot,
    empty,
  );
  const ids = useMemo(() => readIds(raw), [raw]);
  const [error, setError] = useState(false);
  const mark = (items: string[], read: boolean) => {
    readNotices.update((raw) => {
      const latest = readIds(raw);
      for (const id of items) {
        if (read) latest.add(id);
        else latest.delete(id);
      }
      return [...latest];
    }, setError);
  };
  return { ids, mark, error };
}

function readSaved(raw: string): SavedInvestor[] {
  try {
    const ids: unknown = JSON.parse(raw);
    if (!Array.isArray(ids)) return [];
    return ids.filter((value: unknown): value is SavedInvestor => {
      if (!value || typeof value !== "object") return false;
      const p = value as Record<string, unknown>;
      if (typeof p.id !== "string" || typeof p.name !== "string") return false;
      if (p.source !== undefined && !safeExternalHref(p.source)) return false;
      return p.code === undefined
        ? /^[a-z0-9-]+$/.test(p.id)
        : typeof p.code === "string" &&
            REGISTER_CODE_PATTERN.test(p.code) &&
            p.id === filerId(p.code, p.name);
    });
  } catch {
    return [];
  }
}

export function useFollowedInvestors() {
  const raw = useSyncExternalStore(follows.subscribe, follows.snapshot, empty);
  return useMemo(() => readSaved(raw), [raw]);
}

export function FollowInvestor(
  target: (
    | { slug: string; name: string }
    | { code: string; name: string; source?: string }
  ) & { showInbox?: boolean },
) {
  const { name } = target;
  const entry: SavedInvestor =
    "slug" in target
      ? { id: target.slug, name }
      : {
          id: filerId(target.code, name),
          code: target.code,
          name,
          source: safeExternalHref(target.source),
        };
  const followed = useFollowedInvestors().some((p) => p.id === entry.id);
  const label = followed ? "Following" : "Follow";
  const [error, setError] = useState(false);
  const toggle = () => {
    follows.update((raw) => {
      const saved = readSaved(raw);
      return saved.some((p) => p.id === entry.id)
        ? saved.filter((p) => p.id !== entry.id)
        : [...saved, entry];
    }, setError);
  };
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button
        type="button"
        aria-label={`${label} ${name}`}
        aria-pressed={followed}
        onClick={toggle}
        className="min-h-10 rounded-md border px-3 py-1.5 text-xs hover:bg-muted aria-pressed:border-primary aria-pressed:text-primary"
      >
        {label}
      </button>
      {target.showInbox && followed && (
        <Link
          href={AUSTRALIAN_INVESTORS_PATH + "?view=following"}
          prefetch={false}
          className="inline-flex min-h-10 items-center text-xs text-primary underline underline-offset-4 hover:decoration-2"
        >
          View followed filings
        </Link>
      )}
      {error && (
        <span role="status" className="text-xs text-muted-foreground">
          Following could not be saved. Check site storage in this browser and
          try again.
        </span>
      )}
    </span>
  );
}

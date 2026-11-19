"use client";

import { useState, useSyncExternalStore } from "react";

import { REGISTER_CODE_PATTERN } from "~/@/lib/ownership/kinds";
import { safeExternalHref } from "~/@/lib/safe-external-href";
import { filerId } from "~/@/lib/ownership/named-filer";

type SavedInvestor = {
  id: string;
  name: string;
  code?: string;
  source?: string;
};
const KEY = "shorted:ownership:followed-asx-investors:v1";
const CHANGED = "shorted:asx-investors-changed";
const empty = () => "[]";

function snapshot() {
  try {
    return window.localStorage.getItem(KEY) ?? empty();
  } catch {
    return empty();
  }
}

function subscribe(update: () => void) {
  const sync = (e: StorageEvent) => {
    if (!e.key || e.key === KEY) update();
  };
  window.addEventListener("storage", sync);
  window.addEventListener(CHANGED, update);
  return () => {
    window.removeEventListener("storage", sync);
    window.removeEventListener(CHANGED, update);
  };
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
  return readSaved(useSyncExternalStore(subscribe, snapshot, empty));
}

export function FollowInvestor(
  target:
    | { slug: string; name: string }
    | { code: string; name: string; source?: string },
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
  const [error, setError] = useState(false);
  const toggle = () => {
    const saved = readSaved(snapshot());
    const next = saved.some((p) => p.id === entry.id)
      ? saved.filter((p) => p.id !== entry.id)
      : [...saved, entry];
    try {
      window.localStorage.setItem(KEY, JSON.stringify(next));
      setError(false);
      window.dispatchEvent(new Event(CHANGED));
    } catch {
      setError(true);
    }
  };
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button
        type="button"
        aria-label={`Follow ${name}`}
        aria-pressed={followed}
        onClick={toggle}
        className="rounded-md border px-3 py-1.5 text-xs hover:bg-muted aria-pressed:border-primary aria-pressed:text-primary"
      >
        {followed ? "Following" : "Follow"}
      </button>
      {error && (
        <span role="status" className="text-xs text-muted-foreground">
          Browser storage unavailable.
        </span>
      )}
    </span>
  );
}

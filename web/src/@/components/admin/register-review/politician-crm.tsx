"use client";

// The per-politician CRM record.
//
// WHAT THIS SCREEN IS FOR, in priority order:
//  1. MERGE DUPLICATES. 28 people are published twice with split histories
//     (christopher-bowen 26 statements, chris-bowen 9 — one man). That is a
//     wrong fact sitting in public about a named individual, so it is the first
//     thing on the page when it applies, not a tab.
//  2. Correct a fact, with the machine reading visible beside it.
//  3. Replace or clear a portrait.
//
// §7.4 RULE 2 GOVERNS THE LAYOUT: the machine's reading is on screen at all
// times. Every curated field renders the published value with the machine value
// beneath it, struck through — the same grammar DeclaredEntity already uses —
// so a reviewer is comparing against the source rather than reading our answer
// back to themselves.
//
// NOTHING HERE IMPORTS compliance.tsx. It has no "use client" and pulls the
// generated protobuf module, which killed the /politicians static build once
// already (client-boundary.test.ts).

import {
  useCallback,
  useState,
  useTransition,
  type TransitionStartFunction,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PoliticianAvatar } from "@/components/politicians/politician-avatar";
import {
  curatePoliticianFact,
  mergePoliticians,
  setPoliticianPhoto,
  type CrmProfile,
} from "~/app/actions/admin/politicianCrm";

/** Field names rendered readably. The vocabulary is closed by a DB trigger. */
const FIELD_LABEL: Record<string, string> = {
  occupation: "Occupation",
  secondary_occupation: "Secondary occupation",
  qualification: "Qualification",
  preferred_name: "Preferred name",
};

export function PoliticianCrm({ initial }: { initial: CrmProfile }) {
  const router = useRouter();
  const [profile] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();
  const p = profile.profile;

  if (!p) {
    return <p className="text-sm text-muted-foreground">No such politician.</p>;
  }

  return (
    <div className="space-y-6">
      {/* 1. THE DUPLICATE, FIRST. A wrong fact in public outranks everything
             else this screen can do. */}
      {profile.duplicates.length > 0 ? (
        <DuplicatePanel
          slug={p.slug}
          displayName={p.displayName}
          statementCount={p.statementCount}
          duplicates={profile.duplicates}
          onDone={() => router.refresh()}
        />
      ) : null}

      <div className="grid gap-6 md:grid-cols-[220px_minmax(0,1fr)]">
        <aside className="space-y-3">
          <PoliticianAvatar
            displayName={p.displayName}
            partyAb={p.partyAb}
            size="lg"
            photo={{
              photoUrl: profile.photoUrl,
              photoLicence: profile.photoLicence,
              photoAuthor: profile.photoAuthor,
              photoSourceUrl: profile.photoSourceUrl,
            }}
          />
          <PhotoEditor slug={p.slug} profile={profile} onDone={() => router.refresh()} />

          <div className="space-y-1 border-t pt-3 text-[11px] text-muted-foreground">
            <p>
              <span className="text-foreground">{p.statementCount}</span> statements ·{" "}
              <span className="text-foreground">{p.declaredListedCount}</span> declared companies
            </p>
            {p.aphPhid ? <p>APH PHID {p.aphPhid}</p> : <p>no APH PHID — unmatched</p>}
            <p>
              <Link href={`/politicians/${p.slug}`} className="underline underline-offset-2">
                public profile ↗
              </Link>
            </p>
          </div>
        </aside>

        <div className="space-y-6">
          <section className="space-y-2">
            <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Terms
            </h2>
            {profile.terms.length === 0 ? (
              <p className="text-xs text-muted-foreground">No terms recorded.</p>
            ) : (
              <ul className="flex flex-wrap gap-1.5">
                {profile.terms.map((t) => (
                  <li key={`${t.parliament}-${t.chamber}`}>
                    <Badge variant="outline" className="text-[10px]">
                      {t.parliament}P {t.chamber === "senate" ? t.stateCode : t.division}
                      {t.partyAb ? ` · ${t.partyAb}` : ""}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="space-y-2">
            <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Profile facts
            </h2>
            <p className="text-[11px] text-muted-foreground">
              Structured facts from official publications only. There is no biography field and
              there is not meant to be — the editorial standards keep anything that is not an
              official publication out of scope.
            </p>
            {profile.facts.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No facts ingested. Run{" "}
                <code className="font-mono">make register-handbook</code>.
              </p>
            ) : (
              <ul className="divide-y rounded-md border">
                {profile.facts.map((f) => (
                  <FactRow
                    key={`${f.field}-${f.ordinal}`}
                    slug={p.slug}
                    fact={f}
                    onDone={() => router.refresh()}
                    setError={setError}
                    saving={saving}
                    startSaving={startSaving}
                  />
                ))}
              </ul>
            )}
          </section>

          {error ? (
            <p role="alert" className="rounded-md border border-dashed p-2 text-sm">
              {error}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function FactRow({
  slug,
  fact,
  onDone,
  setError,
  saving,
  startSaving,
}: {
  slug: string;
  fact: CrmProfile["facts"][number];
  onDone: () => void;
  setError: (s: string | null) => void;
  saving: boolean;
  // React's own type, not a hand-written `() => void`: a transition callback may
  // be async, and narrowing it here made every awaited action a lint error.
  startSaving: TransitionStartFunction;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(fact.resolvedText);
  const [rationale, setRationale] = useState("");

  const submit = useCallback(
    (action: "amend" | "suppress" | "reinstate") => {
      if (!rationale.trim()) {
        setError("A reason is required — it is the field a dispute is answered from.");
        return;
      }
      startSaving(async () => {
        const r = await curatePoliticianFact({
          slug,
          field: fact.field,
          ordinal: fact.ordinal,
          action,
          curatedText: text,
          rationale,
        });
        if (!r.ok) {
          setError(r.error ?? "Refused.");
          return;
        }
        setError(null);
        setEditing(false);
        setRationale("");
        onDone();
      });
    },
    [slug, fact, text, rationale, onDone, setError, startSaving],
  );

  return (
    <li className="p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {FIELD_LABEL[fact.field] ?? fact.field}
            {fact.isCurated ? (
              <Badge variant="outline" className="ml-2 text-[9px]">
                curated by {fact.curatedBy}
              </Badge>
            ) : null}
          </p>
          <p className="text-sm">{fact.resolvedText}</p>
          {/*
            §7.4 rule 2: the machine's reading stays on screen. A curated value
            with the original struck through beneath it is the only way a
            reviewer can tell what we changed.
          */}
          {fact.isCurated && fact.machineText ? (
            <p className="mt-0.5 font-mono text-[11px] text-muted-foreground line-through">
              {fact.machineText}
            </p>
          ) : null}
          <p className="mt-1 text-[10px] text-muted-foreground">
            {fact.sourceKey}
            {fact.sourceUrl ? (
              <>
                {" · "}
                <a
                  href={fact.sourceUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="underline underline-offset-2"
                >
                  source ↗
                </a>
              </>
            ) : null}
            {fact.sourceLicence ? ` · ${fact.sourceLicence}` : ""}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => setEditing((v) => !v)}
          disabled={saving}
        >
          {editing ? "Cancel" : "Correct"}
        </Button>
      </div>

      {editing ? (
        <div className="mt-3 space-y-2 border-t pt-3">
          <Input value={text} onChange={(e) => setText(e.target.value)} className="text-sm" />
          <Input
            value={rationale}
            onChange={(e) => setRationale(e.target.value)}
            placeholder="Why? (required — recorded against your name)"
            className="text-sm"
          />
          <div className="flex gap-2">
            <Button type="button" size="sm" onClick={() => submit("amend")} disabled={saving}>
              Save correction
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => submit("suppress")}
              disabled={saving}
            >
              Withhold this fact
            </Button>
            {fact.isCurated ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => submit("reinstate")}
                disabled={saving}
              >
                Revert to source
              </Button>
            ) : null}
          </div>
          <p className="text-[10px] text-muted-foreground">
            Append-only: this supersedes the previous decision rather than replacing it, and it
            survives every re-crawl.
          </p>
        </div>
      ) : null}
    </li>
  );
}

function PhotoEditor({
  slug,
  profile,
  onDone,
}: {
  slug: string;
  profile: CrmProfile;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState(profile.photoUrl);
  const [licence, setLicence] = useState(profile.photoLicence);
  const [author, setAuthor] = useState(profile.photoAuthor);
  const [source, setSource] = useState(profile.photoSourceUrl);
  const [err, setErr] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();

  const save = () => {
    startSaving(async () => {
      const r = await setPoliticianPhoto({
        slug,
        photoUrl: url.trim(),
        photoLicence: licence.trim(),
        photoAuthor: author.trim(),
        photoSourceUrl: source.trim(),
      });
      if (!r.ok) {
        setErr(r.error ?? "Refused.");
        return;
      }
      setErr(null);
      setOpen(false);
      onDone();
    });
  };

  if (!open) {
    return (
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
        {profile.photoUrl ? "Replace portrait" : "Add portrait"}
      </Button>
    );
  }

  return (
    <div className="space-y-2 rounded-md border p-2">
      <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Image URL" className="text-xs" />
      <Input value={licence} onChange={(e) => setLicence(e.target.value)} placeholder="Licence (e.g. CC BY-SA 4.0)" className="text-xs" />
      <Input value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="Author / credit" className="text-xs" />
      <Input value={source} onChange={(e) => setSource(e.target.value)} placeholder="Source page URL" className="text-xs" />
      {/*
        Not a style note: CC BY / CC BY-SA permit publication only WITH the
        credit and a link to the terms, so the server and a database CHECK both
        refuse a URL without them. Saying so here means a curator learns the rule
        from the form rather than from a constraint violation.
      */}
      <p className="text-[10px] text-muted-foreground">
        A licence and a source URL are required — publishing a CC BY-SA image without them is a
        breach, not an untidiness. Clear the image URL to fall back to the monogram.
      </p>
      {err ? <p className="text-[10px]">{err}</p> : null}
      <div className="flex gap-2">
        <Button type="button" size="sm" onClick={save} disabled={saving}>
          Save
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function DuplicatePanel({
  slug,
  displayName,
  statementCount,
  duplicates,
  onDone,
}: {
  slug: string;
  displayName: string;
  statementCount: number;
  duplicates: CrmProfile["duplicates"];
  onDone: () => void;
}) {
  const [pending, setPending] = useState<CrmProfile["duplicates"][number] | null>(null);
  const [evidence, setEvidence] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();

  const confirm = () => {
    if (!pending) return;
    startSaving(async () => {
      // The record with MORE history survives, so the merge moves the smaller
      // set onto the larger one and the canonical slug is the one already
      // carrying most of the person's declarations.
      const keep = statementCount >= pending.statementCount ? slug : pending.slug;
      const merge = keep === slug ? pending.slug : slug;
      const r = await mergePoliticians({ keepSlug: keep, mergeSlug: merge, evidence });
      if (!r.ok) {
        setErr(r.error ?? "Refused.");
        return;
      }
      setPending(null);
      setErr(null);
      onDone();
    });
  };

  return (
    <section className="space-y-2 rounded-lg border p-4">
      <h2 className="text-sm font-medium">
        This person appears more than once
      </h2>
      <p className="text-xs text-muted-foreground">
        Another record shares this APH PHID, which means one human is published twice and each
        page shows only part of their declared history. Merging moves the whole history onto one
        record; the other slug keeps resolving as a redirect, because slugs reach OG images and
        the sitemap and are never reassigned.
      </p>
      <ul className="divide-y rounded-md border">
        {duplicates.map((d) => (
          <li key={d.slug} className="flex items-center justify-between gap-3 p-2.5">
            <span className="text-sm">
              <span className="font-medium">{d.displayName}</span>{" "}
              <span className="font-mono text-[11px] text-muted-foreground">{d.slug}</span>
              <span className="block text-[11px] text-muted-foreground">
                {d.statementCount} statements · {d.declaredListedCount} declared companies
              </span>
            </span>
            <Button type="button" size="sm" onClick={() => setPending(d)} disabled={saving}>
              Merge
            </Button>
          </li>
        ))}
      </ul>

      <AlertDialog open={pending !== null} onOpenChange={(o) => !o && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Merge two records into one?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>
                  <span className="font-mono">{displayName}</span> ({statementCount} statements)
                  and <span className="font-mono">{pending?.displayName}</span> (
                  {pending?.statementCount} statements) become one record. The one with more
                  history survives.
                </p>
                <p className="text-muted-foreground">
                  This moves an entire declared history onto a named individual — the
                  highest-blast-radius action in the subsystem. It is recorded against your name
                  and cannot be undone from this screen.
                </p>
                <Input
                  value={evidence}
                  onChange={(e) => setEvidence(e.target.value)}
                  placeholder="Evidence (required) — e.g. APH PHID DZS"
                  className="text-sm"
                />
                {err ? <p className="text-[11px]">{err}</p> : null}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirm} disabled={saving || !evidence.trim()}>
              Merge records
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

"use client";

import { useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/@/components/ui/card";
import type { Person } from "~/@/types/company-metadata";
import { Users, Linkedin, Globe } from "lucide-react";

interface KeyPeopleProps {
  people: Person[];
  companyName: string;
}

function PersonAvatar({ person }: { person: Person }) {
  const [imgError, setImgError] = useState(false);
  const src = person.image_gcs_url ?? person.image_url;

  const initials = person.name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);

  if (!src || imgError) {
    return (
      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border-2 border-border bg-primary/5 text-sm font-semibold text-primary">
        {initials}
      </div>
    );
  }

  return (
    <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded-full border-2 border-border">
      {/* Plain <img>: avatar hosts are arbitrary (LinkedIn, Wikipedia, …) and
          any host missing from next.config images.remotePatterns would make
          next/image throw and take down the whole page. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={person.name}
        width={48}
        height={48}
        loading="lazy"
        decoding="async"
        className="h-full w-full object-cover"
        onError={() => setImgError(true)}
      />
    </div>
  );
}

function WikipediaIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M12.09 13.119c-.936 1.932-2.217 4.548-2.853 5.728-.616 1.074-1.127.991-1.532.016C6.532 16.263 4.267 10.884 3.042 7.97c-.146-.27-.283-.55-.413-.824h2.208c.94 2.16 3.054 7.26 3.838 9.166.271-.574 1.14-2.372 1.654-3.494-.508-1.07-1.752-3.722-2.208-4.774-.246-.541-.462-1.058-.624-1.528h2.158c.515 1.246 1.058 2.394 1.565 3.546.506-1.167 1.06-2.312 1.573-3.546h2.066c-.774 1.646-1.548 3.292-2.35 5.042.508 1.082 1.318 2.738 1.817 3.736.785-1.636 2.895-6.684 3.838-9.116h2.208c-.158.36-.34.724-.536 1.098C17.742 10.884 15.477 16.263 14.302 18.863c-.405.975-.916 1.058-1.532-.016-.607-1.18-1.917-3.796-2.853-5.728z" />
    </svg>
  );
}

// p-2 -m-2 grows each chip's hit area to ~36px without shifting layout.
const SOURCE_LINK_HIT_AREA = "p-2 -m-2 box-content";

function PersonSourceLink({ person }: { person: Person }) {
  // Priority 1: LinkedIn URL
  if (person.linkedin_url) {
    return (
      <a
        href={person.linkedin_url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`${person.name} on LinkedIn (opens in new tab)`}
        className={`inline-flex shrink-0 ${SOURCE_LINK_HIT_AREA}`}
      >
        <span className="inline-flex h-5 w-5 items-center justify-center rounded bg-[#0A66C2] text-white hover:bg-[#004182] transition-colors">
          <Linkedin className="h-3 w-3" aria-hidden />
        </span>
      </a>
    );
  }

  // Priority 2: Wikipedia source
  if (person.source_type === "wikipedia" && person.source_url) {
    return (
      <a
        href={person.source_url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`${person.name} on Wikipedia (opens in new tab)`}
        className={`inline-flex shrink-0 ${SOURCE_LINK_HIT_AREA}`}
      >
        <span className="inline-flex h-5 w-5 items-center justify-center rounded bg-zinc-700 text-white hover:bg-zinc-600 transition-colors">
          <WikipediaIcon className="h-3.5 w-3.5" />
        </span>
      </a>
    );
  }

  // Priority 3: Any other source URL
  if (person.source_url) {
    return (
      <a
        href={person.source_url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`${person.name} source (opens in new tab)`}
        className={`inline-flex shrink-0 ${SOURCE_LINK_HIT_AREA}`}
      >
        <span className="inline-flex h-5 w-5 items-center justify-center rounded bg-zinc-700 text-white hover:bg-zinc-600 transition-colors">
          <Globe className="h-3 w-3" aria-hidden />
        </span>
      </a>
    );
  }

  return null;
}

/** Bare leadership rows — used standalone inside the Company insights accordion. */
export function KeyPeopleList({ people }: { people: Person[] }) {
  const validPeople = people?.filter((p) => p.name?.trim()) ?? [];

  if (validPeople.length === 0) {
    return null;
  }

  return (
    <div className="space-y-6">
      {validPeople.map((person, index) => (
        <div key={index} className="flex gap-4">
          <PersonAvatar person={person} />
          <div className="flex-1 space-y-1">
            <p className="font-semibold text-sm flex items-center gap-1.5">
              {person.name}
              <PersonSourceLink person={person} />
            </p>
            <p className="text-xs text-muted-foreground">{person.role}</p>
            {person.bio && (
              <p className="text-sm text-muted-foreground leading-relaxed pt-0.5">
                {person.bio}
              </p>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

export function KeyPeople({ people, companyName }: KeyPeopleProps) {
  // Filter out entries with empty/missing names (LLM placeholder artifacts)
  const validPeople = people?.filter((p) => p.name?.trim()) ?? [];

  if (validPeople.length === 0) {
    return null;
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg flex items-center gap-2">
          <Users className="h-5 w-5" />
          Key people
        </CardTitle>
        <CardDescription>Leadership team at {companyName}</CardDescription>
      </CardHeader>
      <CardContent>
        <KeyPeopleList people={validPeople} />
      </CardContent>
    </Card>
  );
}

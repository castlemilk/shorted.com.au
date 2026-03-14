"use client";

import { useState } from "react";
import Image from "next/image";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/@/components/ui/card";
import type { Person } from "~/@/types/company-metadata";
import { Users, Linkedin, ExternalLink } from "lucide-react";

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
      <Image
        src={src}
        alt={person.name}
        fill
        sizes="48px"
        className="object-cover"
        onError={() => setImgError(true)}
      />
    </div>
  );
}

function SocialBar({ person }: { person: Person }) {
  const links: { href: string; icon: React.ReactNode; label: string }[] = [];

  if (person.linkedin_url) {
    links.push({
      href: person.linkedin_url,
      icon: <Linkedin className="h-3.5 w-3.5" />,
      label: "LinkedIn",
    });
  }

  if (links.length === 0) return null;

  return (
    <div className="flex items-center gap-1 mt-1">
      {links.map((link) => (
        <a
          key={link.label}
          href={link.href}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`${person.name} on ${link.label}`}
          className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/50 px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
        >
          {link.icon}
          <span>{link.label}</span>
          <ExternalLink className="h-2.5 w-2.5 opacity-50" />
        </a>
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
          Key People
        </CardTitle>
        <CardDescription>Leadership team at {companyName}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-6">
          {validPeople.map((person, index) => (
            <div key={index} className="flex gap-4">
              <PersonAvatar person={person} />
              <div className="flex-1 space-y-1">
                <p className="font-semibold text-sm">{person.name}</p>
                <p className="text-xs text-muted-foreground">{person.role}</p>
                <SocialBar person={person} />
                {person.bio && (
                  <p className="text-sm text-muted-foreground leading-relaxed pt-0.5">
                    {person.bio}
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * A parliamentarian's face, or a stand-in for it.
 *
 * COVERAGE IS 74%, so the fallback is not an edge case — roughly one in four
 * members has no freely-licensed portrait, and the surface has to look
 * deliberate for them rather than broken. The fallback is a MONOGRAM in the
 * member's party colour: it carries real information (who, and which party),
 * it is deterministic, and it is obviously not a photograph. It is never a
 * generic silhouette, which reads as "person unknown" about someone we have
 * named, and never another person's photograph.
 *
 * ATTRIBUTION IS A LICENCE OBLIGATION, NOT A CAPTION. Every portrait comes from
 * Wikimedia Commons under CC BY / CC BY-SA / CC0 / public domain, and the BY
 * family permits publication only with the credit and a link to the terms. So
 * `PortraitCredit` exists, the profile page renders it, and this component
 * refuses to render an image it cannot attribute — a missing licence means we do
 * not have permission, so the monogram is shown instead.
 *
 * WHY NOT aph.gov.au, which has a portrait of everyone: §3.1's licensing posture
 * publishes extracted FACTS and does not mirror the source's artefacts, and
 * parliamentary photographs are the likeliest part of that corpus to carry a
 * separate photographer copyright. Coverage is not worth the breach.
 *
 * NO next/image HERE. Its remotePatterns allowlist crashes the route for any
 * unlisted host, and these URLs come from a third party we do not control
 * (upload.wikimedia.org today, a different shard tomorrow). A plain <img> with
 * explicit dimensions cannot take a page down, and the images are already
 * thumbnailed to 400px by Commons.
 */

import { partyColorFromAb, partyLabel } from "@/lib/politics/party-palette";

export interface PoliticianPhoto {
  photoUrl?: string;
  photoLicence?: string;
  photoAuthor?: string;
  photoSourceUrl?: string;
}

/**
 * Initials from a display name.
 *
 * Takes the FIRST and LAST word, so "Julie-Ann Campbell" is JC and
 * "Llew O'Brien" is LO. Hyphenated and apostrophised names are common here and
 * a naive split produces junk from them.
 */
export function initialsFor(displayName: string): string {
  const words = displayName
    .split(/[\s]+/)
    .map((w) => w.replace(/[^\p{L}]/gu, ""))
    .filter(Boolean);
  if (words.length === 0) return "?";
  const first = words[0]![0]!;
  const last = words.length > 1 ? words[words.length - 1]![0]! : "";
  return (first + last).toUpperCase();
}

const SIZES = {
  sm: { px: 32, text: "text-[11px]" },
  md: { px: 48, text: "text-sm" },
  lg: { px: 96, text: "text-2xl" },
} as const;

export function PoliticianAvatar({
  displayName,
  partyAb,
  photo,
  size = "md",
  className,
}: {
  displayName: string;
  partyAb?: string;
  photo?: PoliticianPhoto;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const { px, text } = SIZES[size];
  // An image we cannot attribute is one we may not publish, so it is treated as
  // absent rather than rendered bare.
  const attributable =
    !!photo?.photoUrl && !!photo.photoLicence && !!photo.photoSourceUrl;

  if (attributable) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={photo.photoUrl}
        alt={`${displayName}`}
        width={px}
        height={px}
        loading="lazy"
        decoding="async"
        className={`shrink-0 rounded-full border object-cover ${className ?? ""}`}
        style={{ width: px, height: px }}
      />
    );
  }

  const tint = partyAb ? partyColorFromAb(partyAb) : undefined;
  return (
    <span
      // Not aria-hidden: it stands in for the person's photograph and carries
      // their initials, so a screen reader should say whose face is missing
      // rather than skip a blank box.
      role="img"
      aria-label={`${displayName}${partyAb ? `, ${partyLabel(partyAb)}` : ""} — no portrait available`}
      title={`${displayName} — no freely-licensed portrait available`}
      className={`inline-flex shrink-0 select-none items-center justify-center rounded-full border font-medium tabular-nums ${text} ${className ?? ""}`}
      style={{
        width: px,
        height: px,
        // A wash rather than a solid fill: the party colour identifies, it does
        // not label the person as their party's colour block.
        backgroundColor: tint ? `${tint}22` : "hsl(var(--muted))",
        color: tint ?? "hsl(var(--muted-foreground))",
        borderColor: tint ? `${tint}55` : "hsl(var(--border))",
      }}
    >
      {initialsFor(displayName)}
    </span>
  );
}

/**
 * The credit line CC BY / CC BY-SA require.
 *
 * Rendered wherever a portrait is rendered at a size worth crediting. Returns
 * null when there is no photo, so a monogram carries no dangling caption.
 */
export function PortraitCredit({
  photo,
  className,
}: {
  photo?: PoliticianPhoto;
  className?: string;
}) {
  if (!photo?.photoUrl || !photo.photoLicence || !photo.photoSourceUrl) return null;
  return (
    <p className={`text-[10px] leading-relaxed text-muted-foreground ${className ?? ""}`}>
      Portrait:{" "}
      <a
        href={photo.photoSourceUrl}
        target="_blank"
        rel="noreferrer noopener"
        className="underline underline-offset-2"
      >
        Wikimedia Commons
      </a>
      {photo.photoAuthor ? ` — ${photo.photoAuthor}` : ""} ({photo.photoLicence}). Not a
      Parliament of Australia image.
    </p>
  );
}

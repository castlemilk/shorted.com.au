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
 * THE next/image LANDMINE IS REAL, AND THE ANSWER IS AN ALLOWLIST PLUS A
 * FALLBACK, NOT ABSTINENCE. `next/image` throws at render for a host missing
 * from `remotePatterns`, and these URLs come from a third party we do not
 * control — so this file keeps its own copy of the allowlist and renders a plain
 * <img> for anything outside it. An unexpected shard degrades to "unoptimized";
 * it can never take a route down. Same posture as <NewsImage>.
 *
 * THE OLD DOCBLOCK CLAIMED COMMONS HAD ALREADY THUMBNAILED THESE TO 400px. It
 * had not. Measured on /politicians (2026-08-02): 3,411 KB of portraits across
 * 38 avatars, a 426 KB 500x558 PNG rendered into a 32 px box, and 97 of the 241
 * URLs in the corpus are raw originals with no /thumb/ segment at all. So this
 * component now does two independent things, and either one alone is a large
 * win:
 *
 *   1. It rewrites every Commons URL to a /thumb/ of a size the avatar can
 *      actually use (`commonsThumb`). Commons' thumbnailer is a pure function of
 *      the URL, so this needs no API call and no stored state. This is the path
 *      the plain-<img> fallback takes.
 *   2. On an allowlisted host it hands that thumb to the optimizer, which
 *      re-encodes to AVIF/WebP at exactly 1x and 2x of the render box.
 *
 * NO `sizes` PROP HERE, DELIBERATELY. For a FIXED-dimension next/image, omitting
 * `sizes` makes Next emit a two-entry srcset of [width, width*2] — precisely the
 * two variants a 32/48/96 px avatar can use. Passing a `sizes` string that
 * carries no `vw` unit (e.g. "32px") sends Next down the `kind: "w"` branch of
 * `getWidths`, where it emits EVERY configured size up to 3840 px. On a fixed
 * box, "no sizes" IS the right sizes.
 */

import Image from "next/image";

import { partyColorFromAb, partyLabel } from "@/lib/politics/party-palette";

/**
 * Hosts allowlisted in next.config.mjs `images.remotePatterns`.
 *
 * Measured against the dev corpus: 241 of 241 non-empty `politicians.photo_url`
 * values are upload.wikimedia.org, so this set is the whole population today and
 * the fallback below covers the day it is not. KEEP IN SYNC with the Wikimedia
 * entry in next.config.mjs — drift in either direction is safe (in-JS but not in
 * config would crash, so this set must never be the LARGER of the two).
 */
const OPTIMIZED_PORTRAIT_HOSTS = new Set<string>(["upload.wikimedia.org"]);

/**
 * The ONLY thumbnail widths upload.wikimedia.org will serve.
 *
 * THIS IS NOT A PREFERENCE LIST, IT IS A HARD CONSTRAINT, and getting it wrong
 * breaks portraits rather than merely making them big. Wikimedia serves
 * thumbnails only at its configured bucket widths and answers anything else with
 * **HTTP 400 and an HTML error page** ("Use thumbnail sizes listed on
 * https://w.wiki/GHai"). A 400 upstream is also fatal through the Next
 * optimizer, which replies `"url" parameter is valid but upstream response is
 * invalid` — so an unbucketed width takes the image out on BOTH render paths.
 *
 * Probed directly against upload.wikimedia.org on 2026-08-02, sweeping every
 * multiple of 10 from 100 to 1390 plus 1920 and 2560. Exactly these seven
 * answered 200; 256, 320, 384, 400 and 512 — all of which look like reasonable
 * choices, and 256 was the first width tried here — return 400.
 *
 * Re-probe before adding to this list. Do not interpolate.
 */
const COMMONS_THUMB_WIDTHS = [120, 250, 330, 500, 960, 1280, 1920] as const;

/**
 * The smallest bucket that still covers `want`, or the largest we have.
 *
 * Snapping UP, never down: a thumb narrower than the box it is drawn into is a
 * visibly soft portrait of a named person, which is worse than a few spare KB.
 */
function thumbWidthFor(want: number): number {
  return (
    COMMONS_THUMB_WIDTHS.find((width) => width >= want) ??
    COMMONS_THUMB_WIDTHS[COMMONS_THUMB_WIDTHS.length - 1]!
  );
}

/** Commons file paths look like /wikipedia/<project>/<a>/<ab>/<File name>. */
const COMMONS_ORIGINAL = /^\/wikipedia\/([^/]+)\/([0-9a-f])\/([0-9a-f]{2})\/(.+)$/;
/** …and a thumb repeats the file name under /thumb/ with an <N>px- prefix. */
const COMMONS_THUMB_LEAF = /^(\d+)px-(.+)$/;

/**
 * The Commons thumbnail URL for a file, at a given width.
 *
 * DETERMINISTIC, NOT DISCOVERED. MediaWiki's thumbnailer derives the thumb path
 * from the original path by rule — insert `/thumb/` after the project segment
 * and append `/<N>px-<file name>` — so this is a pure string function and costs
 * no request. A URL that is ALREADY a thumb has its width re-written in place,
 * which is what shrinks the 500px thumbs the ingest happened to store.
 *
 * `want` is the width the CALLER needs; the width actually requested is snapped
 * up to a bucket Wikimedia will serve (see COMMONS_THUMB_WIDTHS — an unbucketed
 * width is a 400, not a bigger image).
 *
 * Anything this does not recognise is returned untouched. A wrong guess here
 * would break a portrait we have permission to show, so the function only acts
 * on shapes it can prove.
 */
export function commonsThumb(rawUrl: string, want: number): string {
  const width = thumbWidthFor(want);
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  if (url.hostname !== "upload.wikimedia.org") return rawUrl;

  const segments = url.pathname.split("/");
  const leaf = segments[segments.length - 1] ?? "";

  // Already a thumb: re-size it in place.
  if (segments.includes("thumb")) {
    const match = COMMONS_THUMB_LEAF.exec(leaf);
    if (!match) return rawUrl;
    segments[segments.length - 1] = `${width}px-${match[2]}`;
    url.pathname = segments.join("/");
    return url.toString();
  }

  const original = COMMONS_ORIGINAL.exec(url.pathname);
  if (!original) return rawUrl;
  const [, project, shard1, shard2, fileName] = original;
  // Every group is guaranteed by the regex; the guard is for the checker, and it
  // fails the only way this function is allowed to fail — by changing nothing.
  if (!project || !shard1 || !shard2 || !fileName) return rawUrl;
  // A vector original thumbnails to a raster: Commons names those
  // "<N>px-Name.svg.png". Every other type keeps its own extension.
  const thumbLeaf = /\.svg$/i.test(fileName)
    ? `${width}px-${fileName}.png`
    : `${width}px-${fileName}`;
  url.pathname = `/wikipedia/${project}/thumb/${shard1}/${shard2}/${fileName}/${thumbLeaf}`;
  return url.toString();
}

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
    const shared = {
      alt: displayName,
      width: px,
      height: px,
      className: `shrink-0 rounded-full border object-cover ${className ?? ""}`,
      style: { width: px, height: px },
    };
    // Ask Commons for a thumb THIS box can use rather than the stored original.
    // `px * 2` is the retina requirement, and `commonsThumb` snaps that up to a
    // width Wikimedia will actually serve — so sm (32) and md (48) land on the
    // 120px bucket and lg (96) on 250px. Measured for Jim Chalmers: 58,494 B
    // original / 73,610 B at the stored 500px / 27,028 B at 250px / **6,820 B at
    // 120px**, before the optimizer re-encodes it at all.
    const source = commonsThumb(photo.photoUrl!, px * 2);
    let host: string | null = null;
    try {
      host = new URL(source).hostname;
    } catch {
      host = null;
    }

    if (host !== null && OPTIMIZED_PORTRAIT_HOSTS.has(host)) {
      return (
        <Image
          {...shared}
          src={source}
          loading="lazy"
          // A face at 32-96 px does not need 75. Measured no visible difference
          // at avatar size, and it is a further third off the wire.
          quality={60}
        />
      );
    }

    return (
      // A host we have not allowlisted must never reach next/image: it would
      // throw at render and take the whole route down for one odd portrait.
      // `alt` is spelled out rather than left to the spread so jsx-a11y's
      // alt-text rule can see it — it does not follow spreads, and the build
      // fails the lint gate on a bare <img>.
      // eslint-disable-next-line @next/next/no-img-element
      <img {...shared} alt={displayName} src={source} loading="lazy" decoding="async" />
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

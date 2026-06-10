import Image from "next/image";
import { cn } from "~/@/lib/utils";

type Placement = "full" | "left" | "right" | "inset";

// Hosts allow-listed in next.config.mjs images.remotePatterns — next/image is
// safe for these. Anything else falls back to a plain <img> so we never crash
// on an unconfigured remote host.
const NEXT_IMAGE_HOSTS = new Set([
  "storage.googleapis.com",
  "media.licdn.com",
  "lh3.googleusercontent.com",
  "shorted.com.au",
]);

const PLACEMENT_CLASSES: Record<Placement, string> = {
  full: "my-10 w-full",
  left: "my-6 md:float-left md:mr-8 md:w-1/2",
  right: "my-6 md:float-right md:ml-8 md:w-1/2",
  inset: "my-8 mx-auto max-w-md",
};

export function Figure({
  src,
  caption,
  credit,
  placement = "full",
}: {
  src: string;
  caption?: string;
  credit?: string;
  placement?: Placement;
}) {
  let useNextImage = false;
  try {
    useNextImage = NEXT_IMAGE_HOSTS.has(new URL(src).hostname);
  } catch {
    // Malformed URL — render nothing rather than a broken image.
    return null;
  }

  return (
    <figure className={cn(PLACEMENT_CLASSES[placement] ?? PLACEMENT_CLASSES.full)}>
      {useNextImage ? (
        <Image
          src={src}
          alt={caption ?? ""}
          width={1200}
          height={800}
          className="h-auto w-full rounded-lg"
        />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={caption ?? ""} loading="lazy" className="h-auto w-full rounded-lg" />
      )}
      {(caption ?? credit) && (
        <figcaption className="mt-2">
          {caption && <span className="block text-sm text-muted-foreground">{caption}</span>}
          {credit && (
            <span className="mt-1 block text-[10px] uppercase tracking-wider text-muted-foreground/70">
              {credit}
            </span>
          )}
        </figcaption>
      )}
    </figure>
  );
}

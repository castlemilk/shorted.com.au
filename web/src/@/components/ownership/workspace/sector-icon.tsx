import Image from "next/image";
import { cn } from "@/lib/utils";
import { getSectorImagePath } from "~/@/lib/sector-images";

/**
 * A sector's image: the same 256 x 256 cutout the landing page's "Browse by
 * industry", the treemap and the industry pages draw (`/assets/sectors-v2`,
 * mapped by lib/sector-images.ts, where a placeholder or unknown industry is
 * "other"). Decorative: it sits beside the sector's name, in a box that is always
 * reserved, so a sector never moves the line it sits on. Spec 14.2.
 */
export function SectorIcon({
  industry,
  size = 16,
  className,
}: {
  industry: string | null | undefined;
  size?: number;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      data-sector-icon={sectorIconName(industry)}
      className={cn("inline-block shrink-0 align-[-0.15em]", className)}
      style={{ width: size, height: size }}
    >
      <Image src={getSectorImagePath(industry ?? "")} alt="" width={size} height={size} className="rounded-sm" />
    </span>
  );
}

/** The image's name for an industry: the file stem lib/sector-images.ts resolves it to. */
export function sectorIconName(industry: string | null | undefined): string {
  const path = getSectorImagePath(industry ?? "");
  return path.slice(path.lastIndexOf("/") + 1).replace(/\.webp$/, "");
}

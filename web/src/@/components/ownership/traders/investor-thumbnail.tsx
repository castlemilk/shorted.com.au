"use client";
import { useState } from "react";
import Image from "next/image";
import {
  profilePictures,
  type ProfilePicture,
} from "~/server/traders/portraits";

export function PortraitImage({
  picture,
  alt,
  className,
  priority = false,
  width,
  height,
}: {
  picture: ProfilePicture;
  alt: string;
  className: string;
  priority?: boolean;
  width: number;
  height: number;
}) {
  const [failed, setFailed] = useState("");
  if (failed === picture.image) return null;
  return (
    <Image
      unoptimized
      src={picture.image}
      alt={alt}
      width={width}
      height={height}
      priority={priority}
      referrerPolicy="no-referrer"
      onError={() => setFailed(picture.image)}
      className={className}
    />
  );
}

// The enclosing link already names the person. A profile without a verified
// image uses its normal text layout rather than a stand-in face.
export function InvestorThumbnail({
  slug,
  size,
}: {
  slug: string;
  size: "directory" | "graph" | "focus";
}) {
  const photos = profilePictures(slug);
  if (!photos.length) return null;
  const style =
    size === "focus"
      ? "h-16 w-14 sm:h-20 sm:w-16"
      : size === "graph"
        ? "size-11"
        : "size-9";
  return (
    <span
      aria-hidden="true"
      className="inline-flex shrink-0 items-center gap-0.5 empty:hidden"
    >
      {photos.map((p) => (
        <PortraitImage
          key={p.image}
          picture={p}
          alt=""
          width={64}
          height={80}
          className={
            style +
            " rounded-xl border border-border bg-muted object-cover object-[center_32%]"
          }
        />
      ))}
    </span>
  );
}

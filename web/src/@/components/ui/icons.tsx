import Image from "next/image";

export const Icons = {
  logo: ({ className }: { className?: string }) => (
    <Image
      src="/assets/logo-mark-48.png"
      // Decorative: every usage sits beside the visible site name, so a
      // "Shorted" alt reads as "Shorted Shorted" (image-redundant-alt).
      alt=""
      width={24}
      height={24}
      className={className}
      unoptimized
    />
  ),
};

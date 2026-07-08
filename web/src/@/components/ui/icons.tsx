import Image from "next/image";

export const Icons = {
  logo: ({ className }: { className?: string }) => (
    <Image
      src="/assets/logo-mark-48.png"
      alt="Shorted"
      width={24}
      height={24}
      className={className}
      unoptimized
    />
  ),
};

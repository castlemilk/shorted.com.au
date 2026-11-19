import { Globe } from "lucide-react";
import {
  FacebookIcon,
  InstagramIcon,
  LinkedInIcon,
  SubstackIcon,
  XIcon,
  YouTubeIcon,
} from "~/@/components/ui/social-icons";
import type { PublicAccount } from "~/server/traders/public-accounts";

/** The same public platform names are used in the header, directory and source notes. */
export const accountPlatforms = {
  LinkedIn: { label: "LinkedIn", Icon: LinkedInIcon },
  X: { label: "X (Twitter)", Icon: XIcon },
  Facebook: { label: "Facebook", Icon: FacebookIcon },
  Instagram: { label: "Instagram", Icon: InstagramIcon },
  YouTube: { label: "YouTube", Icon: YouTubeIcon },
  Substack: { label: "Substack", Icon: SubstackIcon },
  "Official website": { label: "Website", Icon: Globe },
} satisfies Record<
  PublicAccount["platform"],
  { label: string; Icon: typeof LinkedInIcon | typeof Globe }
>;

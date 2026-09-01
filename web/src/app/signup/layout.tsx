import { type Metadata } from "next";
import { siteConfig } from "~/@/config/site";

/**
 * Sign-up is a utility route. Like `/signin` it inherited the ROOT canonical
 * (`https://shorted.com.au`) and shipped `index, follow`; neither is right for
 * an auth form. See `../signin/layout.tsx` for the full rationale.
 */
export const metadata: Metadata = {
  title: "Create an account",
  description:
    "Create a free Shorted account to track ASX short positions, set alerts and save watchlists.",
  robots: { index: false, follow: false },
  alternates: { canonical: `${siteConfig.url}/signup` },
};

export default function SignUpLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}

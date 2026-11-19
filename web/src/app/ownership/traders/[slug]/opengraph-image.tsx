import { notFound } from "next/navigation";
import { OG_CONTENT_TYPE, OG_SIZE } from "~/@/lib/og/card";
import { TRADERS } from "~/@/lib/ownership/traders";
import { investorShareCard } from "~/server/traders/share-card";

export const alt = "Investor and reporting manager on Shorted";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const revalidate = 3600;

export default async function Image({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const person = TRADERS.find((trader) => trader.slug === slug);
  if (!person) notFound();
  return investorShareCard(person);
}

import { notFound } from "next/navigation";
import { OG_CONTENT_TYPE, OG_SIZE } from "~/@/lib/og/card";
import { investorBySlug } from "~/@/lib/ownership/australian-investors";
import { investorShareCard } from "~/server/traders/share-card";

export const alt = "Named Australian investor and source record on Shorted";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const revalidate = 3600;

export default async function Image({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const person = investorBySlug((await params).slug);
  if (!person) notFound();
  return investorShareCard(person);
}

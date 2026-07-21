import {
  Breadcrumbs,
  BreadcrumbStructuredData,
} from "@/components/seo/breadcrumbs";

/**
 * Economy place-trail: Home › Economy › <State>. Thin wrapper over the shared
 * SEO `Breadcrumbs` (nav aria-label="Breadcrumb") + `BreadcrumbStructuredData`
 * (schema.org BreadcrumbList JSON-LD) so both the visible trail and the
 * structured data stay in lockstep from a single item list.
 */
export function EconomyBreadcrumbs({
  stateName,
  stateSlug,
}: {
  stateName?: string;
  stateSlug?: string;
}) {
  // The last item renders as a non-link span in the visible trail, but its
  // href becomes the BreadcrumbList JSON-LD `item` URL — so give the leaf its
  // canonical /economy/<slug> path rather than an empty string.
  const items = [
    { label: "Economy", href: "/economy" },
    ...(stateName
      ? [{ label: stateName, href: stateSlug ? `/economy/${stateSlug}` : "" }]
      : []),
  ];
  return (
    <>
      <Breadcrumbs items={items} />
      <BreadcrumbStructuredData items={items} />
    </>
  );
}

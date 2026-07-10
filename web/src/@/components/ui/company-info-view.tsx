import { type StockDetails } from "~/gen/stocks/v1alpha1/stocks_pb";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "./card";
import {
  PanelTopIcon,
  MapPinIcon,
  Building2Icon,
  LinkedinIcon,
  TwitterIcon,
  FacebookIcon,
  YoutubeIcon,
  RefreshCwIcon,
} from "lucide-react";
import Link from "next/link";
import { Separator } from "./separator";
import { Skeleton } from "./skeleton";

/**
 * Shared presentational view for the "About" company info card.
 *
 * Rendered by BOTH the server component (companyInfo.tsx) and the client
 * retry twin (company-info-with-retry.tsx) so the markup lives in exactly
 * one place. Keep this module free of a "use client" directive and free of
 * any @connectrpc/connect imports — it must stay renderable from server
 * import chains.
 */
export function CompanyInfoView({
  stockDetails,
}: {
  stockDetails: StockDetails;
}) {
  const isEnriched = stockDetails.enrichmentStatus === "completed";
  const socialLinks = stockDetails.socialMediaLinks;

  // Proto3 string fields default to "" (never null/undefined), so `??`
  // chaining would stop at the first empty string — use `||`.
  const hasSocialLinks =
    isEnriched &&
    Boolean(
      socialLinks &&
        (socialLinks.linkedin ||
          socialLinks.twitter ||
          socialLinks.facebook ||
          socialLinks.youtube),
    );
  // Industry intentionally excluded: it already shows as a badge in the
  // page header (CompanyProfile).
  const hasAnyData = Boolean(
    stockDetails.website || stockDetails.address || hasSocialLinks,
  );

  // If no data at all, show a helpful message
  if (!hasAnyData) {
    return (
      <Card className="sm:col-span-4">
        <CardHeader className="pb-3">
          <CardTitle className="text-lg flex items-center gap-2">
            <Building2Icon className="h-5 w-5" />
            About
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <p className="text-sm text-muted-foreground">
            Company information is being updated. Check back soon.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full">
      <CardHeader className="pb-3">
        <CardTitle className="text-lg flex items-center gap-2">
          <Building2Icon className="h-5 w-5" />
          About
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="space-y-1">
          {/* Summary/Description - Removed from here as it's now in Profile */}

          {/* Website */}
          {stockDetails.website && (
            <>
              <div className="flex content-center justify-between py-1">
                <div className="flex content-center items-center">
                  <div className="flex self-center p-1.5 opacity-70">
                    <PanelTopIcon size={12} />
                  </div>
                  <p className="uppercase font-semibold text-[10px] text-muted-foreground">
                    website
                  </p>
                </div>
                <span className="flex items-center p-1.5 text-xs">
                  <Link
                    href={stockDetails.website}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-600 dark:text-blue-400 hover:underline font-medium"
                  >
                    {
                      stockDetails.website
                        .replace(/^https?:\/\/(www\.)?/, "")
                        .split("/")[0]
                    }
                  </Link>
                </span>
              </div>
              <Separator className="opacity-50" />
            </>
          )}

          {/* Industry intentionally omitted — already a badge in the header */}

          {/* Address */}
          {stockDetails.address && (
            <>
              <div className="flex content-center justify-between py-1">
                <div className="flex content-center items-center">
                  <div className="flex self-center p-1.5 opacity-70">
                    <MapPinIcon size={12} />
                  </div>
                  <p className="uppercase font-semibold text-[10px] text-muted-foreground">
                    address
                  </p>
                </div>
                <span className="flex items-center p-1.5 text-[10px] text-right max-w-[60%] leading-tight font-medium">
                  {stockDetails.address}
                </span>
              </div>
              <Separator className="opacity-50" />
            </>
          )}

          {/* Social Media Links - Only show if enriched */}
          {hasSocialLinks && socialLinks && (
            <>
              <div className="py-2">
                <p className="uppercase font-semibold text-[10px] text-muted-foreground mb-1 px-1.5">
                  Connect
                </p>
                {/* p-2.5 anchors: ~36px hit areas around the 16px icons */}
                <div className="flex gap-1">
                  {socialLinks.linkedin && (
                    <Link
                      href={socialLinks.linkedin}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center justify-center rounded-md p-2.5 text-muted-foreground hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
                      aria-label="Company LinkedIn (opens in new tab)"
                      title="LinkedIn"
                    >
                      <LinkedinIcon size={16} aria-hidden />
                    </Link>
                  )}
                  {socialLinks.twitter && (
                    <Link
                      href={socialLinks.twitter}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center justify-center rounded-md p-2.5 text-muted-foreground hover:text-sky-600 dark:hover:text-sky-400 transition-colors"
                      aria-label="Company Twitter (opens in new tab)"
                      title="Twitter"
                    >
                      <TwitterIcon size={16} aria-hidden />
                    </Link>
                  )}
                  {socialLinks.facebook && (
                    <Link
                      href={socialLinks.facebook}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center justify-center rounded-md p-2.5 text-muted-foreground hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
                      aria-label="Company Facebook (opens in new tab)"
                      title="Facebook"
                    >
                      <FacebookIcon size={16} aria-hidden />
                    </Link>
                  )}
                  {socialLinks.youtube && (
                    <Link
                      href={socialLinks.youtube}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center justify-center rounded-md p-2.5 text-muted-foreground hover:text-red-600 dark:hover:text-red-400 transition-colors"
                      aria-label="Company YouTube (opens in new tab)"
                      title="YouTube"
                    >
                      <YoutubeIcon size={16} aria-hidden />
                    </Link>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Shared skeleton — the server placeholder AND the client loading state.
 * `isRetrying` adds the client-side retry spinner next to the title.
 */
export function CompanyInfoSkeleton({
  isRetrying,
}: {
  isRetrying?: boolean;
}) {
  return (
    <Card className="sm:col-span-4">
      <CardHeader className="pb-3">
        <CardTitle className="text-lg flex items-center gap-2">
          <Building2Icon className="h-5 w-5" />
          About
          {isRetrying && (
            <RefreshCwIcon className="h-4 w-4 animate-spin text-muted-foreground" />
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="flex content-center justify-between">
          <div className="flex content-center">
            <div className="flex self-center p-2">
              <PanelTopIcon size={10} />
            </div>
            <p className="uppercase font-semibold content-center text-xs">
              website
            </p>
          </div>
          <span className="flex items-end content-center p-2 text-xs">
            <Skeleton className="w-[200px] h-[16px]" />
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

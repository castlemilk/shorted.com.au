import { getStockDetails } from "~/app/actions/getStockDetails";
import { type StockDetails } from "~/gen/stocks/v1alpha1/stocks_pb";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "./card";
import { 
  PanelTopIcon, 
  MapPinIcon, 
  Building2Icon,
  LinkedinIcon,
  TwitterIcon,
  FacebookIcon,
  YoutubeIcon
} from "lucide-react";
import Link from "next/link";
import { Separator } from "./separator";
import { Skeleton } from "./skeleton";

export const CompanyInfoPlaceholder = () => (
  <Card className="sm:col-span-4">
    <CardHeader className="pb-3">
      <CardTitle className="flex">About</CardTitle>
      <Separator />

      <CardContent className="p-0">
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
      <Separator />
    </CardHeader>
  </Card>
);

const CompanyInfo = async ({ stockCode }: { stockCode: string }) => {
  const stockDetailsResult = await getStockDetails(stockCode);

  // Show a message if no data is available at all
  if (!stockDetailsResult) {
    return (
      <Card className="sm:col-span-4">
        <CardHeader className="pb-3">
          <CardTitle className="flex">About</CardTitle>
          <Separator />
          <CardContent className="p-0 pt-4">
            <p className="text-sm text-muted-foreground">
              Company information not available
            </p>
          </CardContent>
        </CardHeader>
      </Card>
    );
  }

  const stockDetails: StockDetails = stockDetailsResult;

  const isEnriched = stockDetails.enrichmentStatus === "completed";
  const socialLinks = stockDetails.socialMediaLinks;
  
  const hasAnyData = Boolean(
    stockDetails.summary ??
      stockDetails.website ??
      stockDetails.industry ??
      stockDetails.address ??
      socialLinks,
  );

  // If no data at all, show a helpful message
  if (!hasAnyData) {
    return (
      <Card className="sm:col-span-4">
        <CardHeader className="pb-3">
          <CardTitle className="flex">About</CardTitle>
          <Separator />
          <CardContent className="p-0 pt-4">
            <p className="text-sm text-muted-foreground">
              Company information is being updated. Check back soon.
            </p>
          </CardContent>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card className="sm:col-span-4">
      <CardHeader className="pb-3">
        <CardTitle className="flex">About</CardTitle>
        <Separator />

        <CardContent className="p-0 space-y-0">
          {/* Summary/Description */}
          {stockDetails.summary && (
            <>
              <div className="py-3">
                <CardDescription className="text-sm">
                  {stockDetails.summary}
                </CardDescription>
              </div>
              <Separator />
            </>
          )}

          {/* Website */}
          {stockDetails.website && (
            <>
              <div className="flex content-center justify-between py-2">
                <div className="flex content-center">
                  <div className="flex self-center p-2">
                    <PanelTopIcon size={10} />
                  </div>
                  <p className="uppercase font-semibold content-center text-xs">
                    website
                  </p>
                </div>
                <span className="flex items-end content-center p-2 text-xs">
                  <Link
                    href={stockDetails.website}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-600 hover:underline"
                  >
                    {
                      stockDetails.website
                        .replace(/^https?:\/\/(www\.)?/, "")
                        .split("/")[0]
                    }
                  </Link>
                </span>
              </div>
              <Separator />
            </>
          )}

          {/* Industry */}
          {stockDetails.industry && (
            <>
              <div className="flex content-center justify-between py-2">
                <div className="flex content-center">
                  <div className="flex self-center p-2">
                    <Building2Icon size={10} />
                  </div>
                  <p className="uppercase font-semibold content-center text-xs">
                    industry
                  </p>
                </div>
                <span className="flex items-end content-center p-2 text-xs">
                  {stockDetails.industry}
                </span>
              </div>
              <Separator />
            </>
          )}

          {/* Address */}
          {stockDetails.address && (
            <>
              <div className="flex content-center justify-between py-2">
                <div className="flex content-center">
                  <div className="flex self-center p-2">
                    <MapPinIcon size={10} />
                  </div>
                  <p className="uppercase font-semibold content-center text-xs">
                    address
                  </p>
                </div>
                <span className="flex items-end content-center p-2 text-xs text-right max-w-[60%]">
                  {stockDetails.address}
                </span>
              </div>
              <Separator />
            </>
          )}

          {/* Social Media Links - Only show if enriched */}
          {isEnriched && socialLinks && (
            <>
              <div className="py-3">
                <p className="uppercase font-semibold text-xs mb-2 px-2">
                  Connect
                </p>
                <div className="flex gap-3 px-2">
                  {socialLinks.linkedin && (
                    <Link
                      href={socialLinks.linkedin}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 hover:text-blue-700 transition-colors"
                      title="LinkedIn"
                    >
                      <LinkedinIcon size={18} />
                    </Link>
                  )}
                  {socialLinks.twitter && (
                    <Link
                      href={socialLinks.twitter}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-400 hover:text-blue-500 transition-colors"
                      title="Twitter"
                    >
                      <TwitterIcon size={18} />
                    </Link>
                  )}
                  {socialLinks.facebook && (
                    <Link
                      href={socialLinks.facebook}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 hover:text-blue-700 transition-colors"
                      title="Facebook"
                    >
                      <FacebookIcon size={18} />
                    </Link>
                  )}
                  {socialLinks.youtube && (
                    <Link
                      href={socialLinks.youtube}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-red-600 hover:text-red-700 transition-colors"
                      title="YouTube"
                    >
                      <YoutubeIcon size={18} />
                    </Link>
                  )}
                </div>
              </div>
            </>
          )}
        </CardContent>
      </CardHeader>
    </Card>
  );
};

export default CompanyInfo;

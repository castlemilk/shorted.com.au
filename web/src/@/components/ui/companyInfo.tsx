import { getStockDetails } from "~/app/actions/getStockDetails";
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
    <Card className="w-full">
      <CardHeader className="pb-3">
        <CardTitle className="flex text-sm font-bold uppercase tracking-wider text-muted-foreground">About</CardTitle>
        <Separator className="my-2" />

        <CardContent className="p-0 space-y-1">
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
                    className="text-blue-600 hover:underline font-medium"
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

          {/* Industry */}
          {stockDetails.industry && (
            <>
              <div className="flex content-center justify-between py-1">
                <div className="flex content-center items-center">
                  <div className="flex self-center p-1.5 opacity-70">
                    <Building2Icon size={12} />
                  </div>
                  <p className="uppercase font-semibold text-[10px] text-muted-foreground">
                    industry
                  </p>
                </div>
                <span className="flex items-center p-1.5 text-xs font-medium">
                  {stockDetails.industry}
                </span>
              </div>
              <Separator className="opacity-50" />
            </>
          )}

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
          {isEnriched && socialLinks && (
            <>
              <div className="py-2">
                <p className="uppercase font-semibold text-[10px] text-muted-foreground mb-2 px-1.5">
                  Connect
                </p>
                <div className="flex gap-4 px-1.5">
                  {socialLinks.linkedin && (
                    <Link
                      href={socialLinks.linkedin}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-muted-foreground hover:text-blue-600 transition-colors"
                      title="LinkedIn"
                    >
                      <LinkedinIcon size={16} />
                    </Link>
                  )}
                  {socialLinks.twitter && (
                    <Link
                      href={socialLinks.twitter}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-muted-foreground hover:text-blue-400 transition-colors"
                      title="Twitter"
                    >
                      <TwitterIcon size={16} />
                    </Link>
                  )}
                  {socialLinks.facebook && (
                    <Link
                      href={socialLinks.facebook}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-muted-foreground hover:text-blue-600 transition-colors"
                      title="Facebook"
                    >
                      <FacebookIcon size={16} />
                    </Link>
                  )}
                  {socialLinks.youtube && (
                    <Link
                      href={socialLinks.youtube}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-muted-foreground hover:text-red-600 transition-colors"
                      title="YouTube"
                    >
                      <YoutubeIcon size={16} />
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

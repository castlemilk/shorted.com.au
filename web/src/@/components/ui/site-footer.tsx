import { siteConfig } from "@/config/site";
import { Badge } from "@/components/ui/badge";
import getConfig from "next/config";
import Link from "next/link";
import { File, RouteIcon } from "lucide-react";

// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const { publicRuntimeConfig }: { publicRuntimeConfig: Record<string, string> } =
  getConfig();

const SiteFooter = () => {
  return (
    <footer className="py-6 md:px-8 md:py-0">
      <div className="container flex flex-col items-center justify-between gap-4 md:h-24 md:flex-row">
        <p className="text-balance text-center text-sm leading-loose text-muted-foreground md:text-left">
          Built with ❤️ by{" "}
          <a
            href={siteConfig.links.twitter}
            target="_blank"
            rel="noreferrer"
            className="font-medium underline underline-offset-4"
          >
            castlemilk
          </a>
        </p>
        <div className="flex items-center gap-2">
          <Badge variant="secondary">{publicRuntimeConfig?.version}</Badge>
          <Link href="/roadmap">
            <Badge variant="secondary">
              <RouteIcon className="w-3 h-3 mr-1" />
              roadmap
            </Badge>
          </Link>
          <Link href="/terms">
            <Badge variant="secondary">
              <File className="w-3 h-3 mr-1" />
              terms
            </Badge>
          </Link>
        </div>
      </div>
    </footer>
  );
};

export default SiteFooter;

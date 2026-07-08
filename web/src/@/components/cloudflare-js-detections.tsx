"use client";

import Script from "next/script";
import { usePathname } from "next/navigation";
import {
  isCloudflareJsDetectionPath,
  isCloudflareJsDetectionsManualEnabled,
} from "~/@/lib/cloudflare-js-detections";

declare global {
  interface Window {
    cloudflare?: {
      jsd?: {
        executeOnce?: (options?: {
          callback?: (result: string) => void;
        }) => void | Promise<void>;
      };
    };
  }
}

function executeCloudflareJsDetection() {
  const executeOnce = window.cloudflare?.jsd?.executeOnce;
  if (typeof executeOnce !== "function") return;

  try {
    void executeOnce.call(window.cloudflare?.jsd, {
      callback: (result) => {
        if (process.env.NODE_ENV !== "production") {
          console.debug("[Cloudflare JSD]", result);
        }
      },
    });
  } catch (error) {
    if (process.env.NODE_ENV !== "production") {
      console.debug("[Cloudflare JSD] execution failed", error);
    }
  }
}

export function CloudflareJsDetections() {
  const pathname = usePathname();

  if (
    !isCloudflareJsDetectionsManualEnabled() ||
    !isCloudflareJsDetectionPath(pathname)
  ) {
    return null;
  }

  return (
    <Script
      id="cloudflare-js-detections"
      src="/cdn-cgi/challenge-platform/scripts/jsd/api.js"
      strategy="afterInteractive"
      onReady={executeCloudflareJsDetection}
    />
  );
}

"use client";

import { useState, useEffect } from "react";
import { X, GitPullRequest, AlertTriangle } from "lucide-react";
import {
  config,
  getPreviewPRNumber,
  isPreviewDeployment,
} from "@/config/environment";

export function EnvironmentBanner() {
  const [isVisible, setIsVisible] = useState(false);
  const [prNumber, setPrNumber] = useState<string | null>(null);

  useEffect(() => {
    // Only show in preview environments
    if (config.features.showEnvironmentBanner || isPreviewDeployment()) {
      setIsVisible(true);
      setPrNumber(getPreviewPRNumber());
    }
  }, []);

  if (!isVisible) return null;

  const handleDismiss = () => {
    setIsVisible(false);
    // Store dismissal in session storage
    if (typeof window !== "undefined") {
      sessionStorage.setItem("preview-banner-dismissed", "true");
    }
  };

  return (
    <div className="bg-yellow-50 dark:bg-yellow-900/20 border-b border-yellow-200 dark:border-yellow-800">
      <div className="container mx-auto px-4 py-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm text-yellow-800 dark:text-yellow-200">
            <GitPullRequest className="h-4 w-4" />
            <span className="font-medium">Preview Environment</span>
            {prNumber && (
              <>
                <span className="text-yellow-600 dark:text-yellow-400">•</span>
                <a
                  href={`https://github.com/benebsworth/shorted/pull/${prNumber}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:no-underline"
                >
                  PR #{prNumber}
                </a>
              </>
            )}
            <span className="text-yellow-600 dark:text-yellow-400">•</span>
            <span className="text-yellow-600 dark:text-yellow-400">
              This is a preview deployment with test data
            </span>
          </div>
          <button
            onClick={handleDismiss}
            className="text-yellow-600 hover:text-yellow-800 dark:text-yellow-400 dark:hover:text-yellow-200"
            aria-label="Dismiss banner"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

export function DevelopmentBanner() {
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    // Only show in development
    if (config.isDevelopment && process.env.NODE_ENV === "development") {
      setIsVisible(true);
    }
  }, []);

  if (!isVisible) return null;

  return (
    <div className="bg-blue-50 dark:bg-blue-900/20 border-b border-blue-200 dark:border-blue-800">
      <div className="container mx-auto px-4 py-1">
        <div className="flex items-center gap-2 text-xs text-blue-800 dark:text-blue-200">
          <AlertTriangle className="h-3 w-3" />
          <span>Development Mode</span>
          <span className="text-blue-600 dark:text-blue-400">•</span>
          <span className="font-mono text-blue-600 dark:text-blue-400">
            API: {config.api.url}
          </span>
        </div>
      </div>
    </div>
  );
}

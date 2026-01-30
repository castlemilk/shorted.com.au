"use client";

import { useState } from "react";
import { X, Sparkles } from "lucide-react";
import { SignIn } from "./sign-in";
import { Button } from "./button";

export function LoginPromptBanner() {
  const [isVisible, setIsVisible] = useState(true);

  if (!isVisible) return null;

  return (
    <div className="bg-gradient-to-r from-primary/5 to-accent/5 border-b border-primary/20">
      <div className="container mx-auto px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Sparkles className="h-5 w-5 text-primary" />
            <p className="text-sm text-gray-700 dark:text-gray-300">
              <span className="font-medium">Unlock advanced features:</span>{" "}
              <span className="text-gray-600 dark:text-gray-400">
                Custom dashboards, portfolio tracking, real-time alerts, and more
              </span>
            </p>
          </div>
          <div className="flex items-center gap-2">
            <SignIn size="sm" variant="ghost" />
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0"
              onClick={() => setIsVisible(false)}
            >
              <X className="h-4 w-4" />
              <span className="sr-only">Close</span>
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
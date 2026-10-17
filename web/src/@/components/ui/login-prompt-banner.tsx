"use client";

import { useState } from "react";
import { X, Sparkles } from "lucide-react";
import { SignIn } from "./sign-in";
import { Button } from "./button";

/**
 * The signed-out sign-in prompt, one line at every width.
 *
 * It is exactly 44px tall (`h-11`) whatever the viewport, because critical CSS
 * reserves one height for it (`.login-slot` in styles/critical-css.ts: this 44px
 * plus the 2px border of the wrapper the page draws round it) so that mounting
 * it after hydration fills space rather than pushing content down. The line
 * never wraps. Below `sm` it carries "Get alerts", from `sm` "Dashboards,
 * portfolios and alerts", and `truncate` stays as the fallback should a width
 * ever fall short.
 *
 * The copy is sized to its room. The copy area is what the row leaves after the
 * page's 2rem gutters, the wrapper's border, the banner's padding, the 16px icon
 * and the buttons (SignIn 99px, dismiss 32px): 99px at 360px wide, 129px at
 * 390px and 363px at 640px, measured in a browser. In the page's mono face
 * (14px, 8.4px a character) "Get alerts" needs 84px and the long copy 277px, so
 * neither is clipped from 360px up (320px may be). The first phone copy, "Sign
 * in for alerts and portfolios" (277px), was clipped at every width from 320px
 * to 412px. Change the copy only with the same check.
 */
export function LoginPromptBanner() {
  const [isVisible, setIsVisible] = useState(true);

  const dismiss = () => {
    setIsVisible(false);
    // Collapse the CLS-reservation slot (html.anon reserves the banner's
    // height in critical CSS) — this shift follows user input, so it's
    // CLS-exempt.
    document.documentElement.classList.remove("anon");
  };

  if (!isVisible) return null;

  return (
    <div className="flex h-11 items-center gap-2 bg-gradient-to-r from-primary/5 to-accent/5 px-3 sm:gap-3 sm:px-4">
      <Sparkles
        className="h-4 w-4 shrink-0 text-primary"
        aria-hidden="true"
      />
      <p className="min-w-0 flex-1 truncate text-sm text-foreground">
        <span className="sm:hidden">Get alerts</span>
        <span className="hidden sm:inline">
          Dashboards, portfolios and alerts
        </span>
      </p>
      <div className="flex shrink-0 items-center gap-2">
        <SignIn size="sm" variant="ghost" />
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0"
          onClick={dismiss}
        >
          <X className="h-4 w-4" />
          <span className="sr-only">Close</span>
        </Button>
      </div>
    </div>
  );
}

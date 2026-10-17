/**
 * Critical CSS - Inline styles for above-the-fold content
 * 
 * This is exported as a TypeScript string to be inlined in the HTML <head>
 * to prevent render-blocking and FOUC (Flash of Unstyled Content)
 */

export const criticalCSS = `
/* Critical CSS - CSS variables and body styles only.
 * DO NOT duplicate Tailwind utility classes here (.flex, .hidden, .w-full, etc.)
 * because this inline <style> renders AFTER the external Tailwind <link> stylesheet,
 * which means these rules would override Tailwind's responsive variants
 * (e.g., .flex here overrides @media(min-width:768px){.md\\:hidden{display:none}}). */

/* CSS Variables - Amber Terminal Glow Theme */
:root {
  --background: 40 25% 97%;
  --foreground: 19 18% 24%;
  --muted: 40 15% 94%;
  --font-sans: 'IBM Plex Mono', 'JetBrains Mono', ui-monospace, monospace;
}

.dark {
  --background: 0 0% 5%;
  --foreground: 48 52% 81%;
  --muted: 0 0% 12%;
}

body {
  margin: 0;
  padding: 0;
  font-family: var(--font-sans), system-ui, -apple-system, sans-serif;
  background-color: hsl(var(--background));
  color: hsl(var(--foreground));
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

/* Loading skeleton - Critical for perceived performance */
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

/* CLS guard for the client-gated login banner (the stock Overview only):
   layout.tsx's pre-paint script adds html.anon when no session cookie is
   present; reserving the banner's rendered height here means the
   post-hydration insert fills space instead of pushing content down.
   The banner is one line at every width (login-prompt-banner.tsx), so one
   height serves every breakpoint: the 44px banner plus the 2px border of the
   wrapper the page draws round it. Change one and change the other.
   Dismissing the banner removes .anon (user-input shifts are CLS-exempt). */
.login-slot { min-height: 0; }
html.anon .login-slot { min-height: 46px; margin-bottom: 1rem; }
`.trim();


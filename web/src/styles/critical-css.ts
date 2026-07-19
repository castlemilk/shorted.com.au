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

/* CLS guard for the client-gated login banner (stock pages):
   layout.tsx's pre-paint script adds html.anon when no session cookie is
   present; reserving the banner's rendered height here means the
   post-hydration insert fills space instead of pushing content down.
   Heights measured per breakpoint (mobile wraps to two lines). Dismissing
   the banner removes .anon (user-input shifts are CLS-exempt). */
.login-slot { min-height: 0; }
html.anon .login-slot { min-height: 127px; margin-bottom: 1rem; }
@media (min-width: 640px) {
  html.anon .login-slot { min-height: 67px; }
}
@media (min-width: 1024px) {
  html.anon .login-slot { min-height: 63px; }
}
`.trim();


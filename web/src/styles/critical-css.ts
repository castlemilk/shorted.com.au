/**
 * Critical CSS - Inline styles for above-the-fold content
 * 
 * This is exported as a TypeScript string to be inlined in the HTML <head>
 * to prevent render-blocking and FOUC (Flash of Unstyled Content)
 */

export const criticalCSS = `
/* Critical CSS - Above the fold styles only */

/* CSS Variables - Critical for theme support */
:root {
  --background: 0 0% 100%;
  --foreground: 222.2 84% 4.9%;
  --font-sans: 'Inter', sans-serif;
}

.dark {
  --background: 222.2 84% 4.9%;
  --foreground: 210 40% 98%;
}

/* Base reset - Critical for preventing layout shift */
* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
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

/* Critical layout styles for above-fold content */
.min-h-screen {
  min-height: 100vh;
}

.flex {
  display: flex;
}

.flex-col {
  flex-direction: column;
}

.items-center {
  align-items: center;
}

.justify-between {
  justify-content: space-between;
}

.w-full {
  width: 100%;
}

.h-full {
  height: 100%;
}

/* Critical spacing */
.m-2 {
  margin: 0.5rem;
}

.p-4 {
  padding: 1rem;
}

/* Critical typography */
.text-base {
  font-size: 1rem;
  line-height: 1.5;
}

.font-sans {
  font-family: var(--font-sans), system-ui, -apple-system, sans-serif;
}

/* Loading skeleton - Critical for perceived performance */
.animate-pulse {
  animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
}

@keyframes pulse {
  0%, 100% {
    opacity: 1;
  }
  50% {
    opacity: 0.5;
  }
}

.rounded-md {
  border-radius: 0.375rem;
}

.bg-muted {
  background-color: hsl(var(--muted, 210 40% 96.1%));
}

/* Responsive breakpoints - Critical */
@media (min-width: 1024px) {
  .lg\\:flex-row {
    flex-direction: row;
  }
  
  .lg\\:w-2\\/5 {
    width: 40%;
  }
  
  .lg\\:w-3\\/5 {
    width: 60%;
  }
}
`.trim();


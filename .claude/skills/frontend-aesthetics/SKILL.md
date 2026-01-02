---
name: frontend-aesthetics
description: Create distinctive, award-winning UI that avoids generic "AI slop" aesthetics. Use when building new pages, components, or features that need to be visually striking and memorable. Triggers on "beautiful UI", "stunning design", "award-winning", "aesthetic", "stylish interface".
allowed-tools: Read, Write, Grep, Glob
---

# Frontend Aesthetics

Create distinctive, production-grade frontend interfaces that avoid generic "AI slop" aesthetics. Implement real working code with exceptional attention to aesthetic details and creative choices.

## Tech Stack Context

```
Shorted Frontend Stack:
├── Next.js 14 (App Router, RSC)
├── TailwindCSS 3.x           # Utility-first styling
├── shadcn/ui                  # Component library (Radix primitives + Tailwind styling)
│   └── Pre-styled, accessible components
├── Visx                       # Data visualization charts
├── Lucide Icons              # Icon library
├── next-themes               # Dark/light mode
└── tailwind-merge + clsx     # Class composition via cn()

Key Files:
├── web/components.json        # shadcn/ui configuration
├── web/tailwind.config.ts     # Theme configuration
├── web/src/styles/globals.css # CSS variables, base styles
├── web/src/@/lib/utils.ts     # cn() helper
└── web/src/@/components/ui/   # shadcn components (Button, Card, Dialog, etc.)
```

## shadcn/ui Reference

shadcn/ui is a collection of beautifully-designed, accessible components built with TypeScript, Tailwind CSS, and Radix UI primitives. Components are copied into your codebase - you OWN them and can customize freely.

### Available Components

**Form & Input:**

- `Button`, `Button Group` - Multiple variants and sizes
- `Input`, `Input Group`, `Input OTP` - Text inputs with addons
- `Textarea`, `Checkbox`, `Radio Group`, `Switch`, `Slider`
- `Select`, `Combobox` - Dropdowns with autocomplete
- `Calendar`, `Date Picker` - Date selection
- `Form`, `Field`, `Label` - Form building with React Hook Form + Zod

**Layout & Navigation:**

- `Accordion`, `Tabs`, `Collapsible` - Content organization
- `Breadcrumb`, `Navigation Menu`, `Sidebar` - Navigation
- `Separator`, `Scroll Area`, `Resizable` - Layout utilities

**Overlays & Dialogs:**

- `Dialog`, `Alert Dialog`, `Sheet`, `Drawer` - Modal overlays
- `Popover`, `Tooltip`, `Hover Card` - Floating content
- `Dropdown Menu`, `Context Menu`, `Menubar` - Menus
- `Command` - Command palette (cmdk)

**Feedback & Status:**

- `Alert`, `Toast` (Sonner) - Notifications
- `Progress`, `Spinner`, `Skeleton` - Loading states
- `Badge`, `Empty` - Status indicators

**Display & Data:**

- `Card`, `Avatar`, `Typography` - Content display
- `Table`, `Data Table` - Data with sorting/filtering/pagination
- `Chart` (Recharts), `Carousel` (Embla) - Visualizations
- `Aspect Ratio`, `Kbd`, `Item` - Utilities

### Adding Components

```bash
# Add individual components
npx shadcn@latest add button
npx shadcn@latest add card dialog toast

# Add multiple at once
npx shadcn@latest add table data-table chart
```

### Customizing Components

Components live in `web/src/@/components/ui/` - modify them directly:

```tsx
// web/src/@/components/ui/button.tsx - you own this!
const buttonVariants = cva(
  "inline-flex items-center justify-center rounded-md text-sm font-medium...",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        // Add your own variants:
        accent: "bg-accent text-accent-foreground shadow-lg shadow-accent/25",
        glow: "bg-accent text-accent-foreground shadow-lg shadow-accent/30 hover:shadow-xl hover:shadow-accent/40",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-9 rounded-md px-3",
        lg: "h-11 rounded-md px-8",
        // Add custom sizes:
        xl: "h-14 rounded-lg px-10 text-lg font-semibold",
      },
    },
  }
);
```

### Theming with CSS Variables

shadcn/ui uses CSS variables for theming. Define in `globals.css`:

```css
@layer base {
  :root {
    --background: 0 0% 100%;
    --foreground: 222.2 84% 4.9%;
    --card: 0 0% 100%;
    --card-foreground: 222.2 84% 4.9%;
    --popover: 0 0% 100%;
    --popover-foreground: 222.2 84% 4.9%;
    --primary: 222.2 47.4% 11.2%;
    --primary-foreground: 210 40% 98%;
    --secondary: 210 40% 96%;
    --secondary-foreground: 222.2 47.4% 11.2%;
    --muted: 210 40% 96%;
    --muted-foreground: 215.4 16.3% 46.9%;
    --accent: 142 76% 36%; /* Your signature color */
    --accent-foreground: 0 0% 100%;
    --destructive: 0 84.2% 60.2%;
    --destructive-foreground: 210 40% 98%;
    --border: 214.3 31.8% 91.4%;
    --input: 214.3 31.8% 91.4%;
    --ring: 222.2 84% 4.9%;
    --radius: 0.5rem;
  }

  .dark {
    --background: 222.2 84% 4.9%;
    --foreground: 210 40% 98%;
    /* ... dark mode overrides */
  }
}
```

### Dark Mode (next-themes)

Already configured in the project:

```tsx
// Toggle theme
import { useTheme } from "next-themes";

const { theme, setTheme } = useTheme();
setTheme("dark"); // or "light" or "system"
```

### Documentation Links

- [Theming Guide](https://ui.shadcn.com/docs/theming)
- [Dark Mode - Next.js](https://ui.shadcn.com/docs/dark-mode/next)
- [Forms with React Hook Form](https://ui.shadcn.com/docs/forms/react-hook-form)
- [Data Table](https://ui.shadcn.com/docs/components/data-table)

## Design Thinking Process

Before coding, commit to a **BOLD** aesthetic direction:

### 1. Purpose

What problem does this interface solve? Who uses it?

### 2. Tone - Pick an Extreme

Choose ONE and execute with precision:

| Aesthetic               | Description                                    | When to Use               |
| ----------------------- | ---------------------------------------------- | ------------------------- |
| **Brutally minimal**    | Stark, lots of whitespace, dramatic typography | Landing pages, statements |
| **Data-dense terminal** | Monospace, dark mode, information-rich         | Dashboards, analytics     |
| **Luxury financial**    | Bloomberg-inspired, sophisticated, precise     | Professional tools        |
| **Editorial/magazine**  | Large type, asymmetric layouts, photography    | Content, about pages      |
| **Retro-futuristic**    | Neon accents, gradients, sci-fi vibes          | Creative, experimental    |
| **Art deco/geometric**  | Gold accents, patterns, elegant shapes         | Premium features          |

### 3. Differentiation

What makes this UNFORGETTABLE? What's the one thing someone will remember?

**CRITICAL**: Choose a clear conceptual direction and execute with precision. Bold maximalism and refined minimalism both work - the key is intentionality.

## Typography with Tailwind

### AVOID Generic Fonts (AI Slop)

```tsx
// ❌ NEVER - These scream "AI generated"
className = "font-sans"; // Inter, system fonts
className = "font-inter"; // Overused
className = "font-roboto"; // Generic
```

### USE Distinctive Fonts

Configure in `tailwind.config.ts`:

```typescript
// tailwind.config.ts
import { fontFamily } from "tailwindcss/defaultTheme";

export default {
  theme: {
    extend: {
      fontFamily: {
        // Display fonts - bold, memorable headlines
        display: ["'Clash Display'", ...fontFamily.sans],
        heading: ["'Cabinet Grotesk'", ...fontFamily.sans],

        // Body fonts - refined, readable
        body: ["'Satoshi'", ...fontFamily.sans],

        // Mono fonts - for financial data/numbers
        mono: ["'JetBrains Mono'", ...fontFamily.mono],
        tabular: ["'IBM Plex Mono'", ...fontFamily.mono],
      },
    },
  },
};
```

Load fonts in `layout.tsx`:

```tsx
import localFont from "next/font/local";
// Or from Google Fonts (less distinctive but easier):
import { Space_Grotesk, DM_Sans, Outfit } from "next/font/google";

const displayFont = localFont({
  src: "../fonts/ClashDisplay-Variable.woff2",
  variable: "--font-display",
  display: "swap",
});

// Apply to html
<html className={`${displayFont.variable}`}>
```

### Typography Scale - Make It Count

```tsx
// Headlines - BOLD statements
<h1 className="font-display text-6xl md:text-8xl font-bold tracking-tight leading-none">
  Short Interest
</h1>

// Subheadings - refined contrast
<h2 className="font-heading text-2xl font-medium text-muted-foreground tracking-tight">
  Australian Market Data
</h2>

// Data numbers - tabular, precise
<span className="font-tabular text-3xl tabular-nums tracking-tight">
  {shortPercent.toFixed(2)}%
</span>

// Eyebrow text - small but impactful
<span className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
  Live Data
</span>
```

## Color Systems

### AVOID Clichéd Palettes

```tsx
// ❌ NEVER - Purple gradients on white (AI slop signature)
className = "bg-gradient-to-r from-purple-500 to-pink-500";

// ❌ NEVER - Generic blue everything
className = "bg-blue-500 hover:bg-blue-600";

// ❌ NEVER - Washed out pastels without purpose
className = "bg-purple-100 text-purple-800";
```

### CREATE Distinctive Palettes

Define in `globals.css` with CSS variables:

```css
@layer base {
  :root {
    /* Signature accent - pick ONE memorable color */
    --accent: 142 76% 36%; /* Emerald for gains */
    --accent-foreground: 0 0% 100%;
    --accent-muted: 142 40% 90%;

    /* Semantic colors for financial data */
    --positive: 142 76% 36%; /* Gains - emerald */
    --negative: 0 84% 60%; /* Losses - red */
    --neutral: 220 9% 46%; /* Unchanged */

    /* Surfaces - create depth hierarchy */
    --background: 0 0% 100%;
    --surface-1: 0 0% 100%;
    --surface-2: 220 14% 96%;
    --surface-3: 220 13% 91%;

    /* Borders with intention */
    --border: 220 13% 91%;
    --border-subtle: 220 13% 95%;
    --border-strong: 220 9% 46%;
  }

  .dark {
    /* Dark mode: rich blacks, not muddy grays */
    --background: 224 71% 4%;
    --surface-1: 222 47% 8%;
    --surface-2: 222 47% 11%;
    --surface-3: 222 47% 14%;

    /* Accent POPS more in dark mode */
    --accent: 142 70% 45%;

    /* Borders subtle but present */
    --border: 222 47% 18%;
    --border-subtle: 222 47% 14%;
  }
}
```

Use semantically throughout components:

```tsx
// Gains/losses with clear visual hierarchy
<Badge className={cn(
  "font-tabular tabular-nums",
  isPositive
    ? "bg-positive/10 text-positive border-positive/20"
    : "bg-negative/10 text-negative border-negative/20"
)}>
  {isPositive ? "+" : ""}{change.toFixed(2)}%
</Badge>

// Accent for primary actions
<Button className="bg-accent text-accent-foreground shadow-lg shadow-accent/25">
  View Details
</Button>
```

## Motion & Animation

### Configure in tailwind.config.ts

```typescript
export default {
  theme: {
    extend: {
      animation: {
        "fade-in": "fadeIn 0.5s ease-out forwards",
        "slide-up": "slideUp 0.5s ease-out forwards",
        "slide-in-right": "slideInRight 0.3s ease-out forwards",
        "scale-in": "scaleIn 0.2s ease-out forwards",
        "pulse-subtle": "pulseSubtle 2s ease-in-out infinite",
        shimmer: "shimmer 2s linear infinite",
        glow: "glow 2s ease-in-out infinite alternate",
      },
      keyframes: {
        fadeIn: {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        slideUp: {
          "0%": { opacity: "0", transform: "translateY(20px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        slideInRight: {
          "0%": { opacity: "0", transform: "translateX(20px)" },
          "100%": { opacity: "1", transform: "translateX(0)" },
        },
        scaleIn: {
          "0%": { opacity: "0", transform: "scale(0.95)" },
          "100%": { opacity: "1", transform: "scale(1)" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
        glow: {
          "0%": { boxShadow: "0 0 20px rgba(16, 185, 129, 0.2)" },
          "100%": { boxShadow: "0 0 30px rgba(16, 185, 129, 0.4)" },
        },
      },
    },
  },
};
```

### Staggered Reveals (High Impact)

One well-orchestrated page load creates more delight than scattered micro-interactions:

```tsx
export function StockList({ stocks }: { stocks: Stock[] }) {
  return (
    <ul className="space-y-2">
      {stocks.map((stock, i) => (
        <li
          key={stock.code}
          className="animate-slide-up opacity-0"
          style={{
            animationDelay: `${i * 50}ms`,
            animationFillMode: "forwards",
          }}
        >
          <StockRow stock={stock} />
        </li>
      ))}
    </ul>
  );
}
```

### Hover States That Surprise

```tsx
<Card
  className={cn(
    "group relative overflow-hidden",
    "transition-all duration-300 ease-out",
    "hover:shadow-xl hover:shadow-accent/5",
    "hover:-translate-y-1",
    "hover:border-accent/50"
  )}
>
  {/* Background glow on hover */}
  <div
    className={cn(
      "absolute inset-0 opacity-0 transition-opacity duration-300",
      "bg-gradient-to-br from-accent/5 via-transparent to-transparent",
      "group-hover:opacity-100"
    )}
  />

  {/* Arrow that slides in */}
  <ArrowRight
    className={cn(
      "absolute right-4 top-1/2 -translate-y-1/2",
      "opacity-0 -translate-x-2",
      "transition-all duration-300",
      "group-hover:opacity-100 group-hover:translate-x-0"
    )}
  />

  <div className="relative z-10">{children}</div>
</Card>
```

## Backgrounds & Atmosphere

### Grid Patterns

```tsx
// Subtle dot grid
<div className="absolute inset-0 bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] [background-size:16px_16px] opacity-50" />

// Line grid
<div className="absolute inset-0 bg-[linear-gradient(to_right,#8080800a_1px,transparent_1px),linear-gradient(to_bottom,#8080800a_1px,transparent_1px)] bg-[size:24px_24px]" />

// Gradient grid for dark mode
<div className="absolute inset-0 bg-[linear-gradient(to_right,#ffffff05_1px,transparent_1px),linear-gradient(to_bottom,#ffffff05_1px,transparent_1px)] bg-[size:32px_32px]" />
```

### Gradient Meshes & Orbs

```tsx
<div className="relative overflow-hidden">
  {/* Gradient orbs for atmosphere */}
  <div className="absolute -top-40 -right-40 h-80 w-80 rounded-full bg-accent/20 blur-3xl" />
  <div className="absolute -bottom-40 -left-40 h-80 w-80 rounded-full bg-primary/10 blur-3xl" />
  <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-96 w-96 rounded-full bg-accent/5 blur-3xl" />

  {/* Content above the atmosphere */}
  <div className="relative z-10">{children}</div>
</div>
```

### Noise Texture

Add to `globals.css`:

```css
.noise-overlay::before {
  content: "";
  position: absolute;
  inset: 0;
  background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.65' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E");
  opacity: 0.03;
  pointer-events: none;
}
```

## Layout & Composition

### Break the Grid

```tsx
// Overlapping elements create depth
<div className="relative">
  <Card className="relative z-10">Main content</Card>
  <div className="absolute -bottom-4 -right-4 z-0 h-full w-full rounded-xl bg-accent/10" />
</div>

// Asymmetric layouts
<div className="grid grid-cols-12 gap-6">
  <div className="col-span-12 md:col-span-7">Large content area</div>
  <div className="col-span-12 md:col-span-5 md:-mt-12">Offset sidebar</div>
</div>

// Diagonal sections
<section className="relative -skew-y-3 bg-surface-2 py-24">
  <div className="skew-y-3">Content stays straight</div>
</section>

// Full-bleed with contained content
<section className="bg-surface-2">
  <div className="mx-auto max-w-7xl px-4 py-24">
    Contained content
  </div>
</section>
```

### Generous Negative Space

```tsx
// Let hero content breathe
<section className="py-32 md:py-48">
  <div className="mx-auto max-w-2xl text-center">
    <h1 className="text-5xl md:text-7xl font-display font-bold mb-8">
      One powerful statement
    </h1>
    <p className="text-xl text-muted-foreground leading-relaxed mb-12">
      Supporting text with room to breathe and be read.
    </p>
    <Button size="lg">Primary Action</Button>
  </div>
</section>

// Card grids with breathing room
<div className="grid gap-8 md:grid-cols-2 lg:grid-cols-3">
  {items.map(item => (
    <Card key={item.id} className="p-8">{item}</Card>
  ))}
</div>
```

## Data Visualization with Visx

### Chart Color Palette

```tsx
// Define a distinctive palette
const CHART_COLORS = {
  // Primary series
  primary: "hsl(142, 76%, 36%)", // Emerald accent
  secondary: "hsl(220, 70%, 50%)", // Blue
  tertiary: "hsl(45, 93%, 47%)", // Amber

  // Semantic
  positive: "hsl(142, 76%, 36%)",
  negative: "hsl(0, 84%, 60%)",

  // UI elements
  grid: "hsl(220, 13%, 91%)",
  gridDark: "hsl(222, 47%, 18%)",
  axis: "hsl(220, 9%, 46%)",

  // Categorical palette (for multi-series)
  series: [
    "#10b981", // Emerald
    "#3b82f6", // Blue
    "#f59e0b", // Amber
    "#ef4444", // Red
    "#8b5cf6", // Violet
    "#06b6d4", // Cyan
  ],
};

// Gradient fills for area charts
<LinearGradient
  id="area-gradient"
  from={CHART_COLORS.primary}
  to={CHART_COLORS.primary}
  fromOpacity={0.3}
  toOpacity={0}
/>;
```

### Chart Typography

```tsx
// Axis labels - subtle but readable
<AxisBottom
  tickLabelProps={() => ({
    fill: "hsl(var(--muted-foreground))",
    fontSize: 11,
    fontFamily: "var(--font-mono)",
    textAnchor: "middle",
  })}
/>

// Chart titles
<text
  x={0}
  y={-16}
  className="fill-foreground font-display text-lg font-semibold"
>
  Short Interest Over Time
</text>
```

## Component Patterns

### Skeleton with Shimmer

```tsx
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "animate-shimmer rounded-md",
        "bg-gradient-to-r from-muted via-muted-foreground/10 to-muted",
        "bg-[length:200%_100%]",
        className
      )}
    />
  );
}

// Usage
<Skeleton className="h-8 w-32" />
<Skeleton className="h-4 w-full" />
```

### Glass Morphism

```tsx
<Card
  className={cn(
    "backdrop-blur-xl bg-background/80",
    "border border-white/10",
    "shadow-xl shadow-black/5"
  )}
>
  {children}
</Card>
```

### Data Badge with Glow

```tsx
<span
  className={cn(
    "inline-flex items-center gap-1 px-2 py-0.5 rounded-full",
    "font-tabular text-sm tabular-nums",
    isPositive && "bg-positive/10 text-positive shadow-sm shadow-positive/20",
    !isPositive && "bg-negative/10 text-negative shadow-sm shadow-negative/20"
  )}
>
  {isPositive ? (
    <TrendingUp className="h-3 w-3" />
  ) : (
    <TrendingDown className="h-3 w-3" />
  )}
  {value}%
</span>
```

## Anti-Patterns Checklist

Before shipping, verify you haven't fallen into these traps:

| ❌ AI Slop                 | ✅ Distinctive                          |
| -------------------------- | --------------------------------------- |
| `font-sans` (Inter/system) | Custom display + body fonts             |
| Purple-pink gradient       | Single memorable accent color           |
| `bg-blue-500` buttons      | Accent with shadow glow                 |
| Even spacing everywhere    | Intentional rhythm, generous whitespace |
| Plain white background     | Subtle patterns, gradients, depth       |
| Generic card borders       | Hover states, subtle shadows, glow      |
| Static page load           | Staggered animations, reveals           |
| Same design every time     | Unique aesthetic per context            |

## Final Checklist

- [ ] **Font choice**: Is it distinctive and memorable?
- [ ] **Color palette**: Does the accent pop? Is there one signature color?
- [ ] **Animations**: Is page load orchestrated with staggered reveals?
- [ ] **Hover states**: Do interactive elements surprise and delight?
- [ ] **Dark mode**: Does the design shine even more in dark?
- [ ] **Negative space**: Is there room to breathe?
- [ ] **Details**: Borders, shadows, transitions - all intentional?

Remember: Claude is capable of extraordinary creative work. Don't hold back - show what can truly be created when thinking outside the box and committing fully to a distinctive vision.

# Frontend Aesthetics

Create distinctive, award-winning UI that avoids generic "AI slop" aesthetics. Use when building new pages, components, or features that need to be visually striking and memorable.

## Tech Stack Context

```
Shorted Frontend Stack:
├── Next.js 14 (App Router, RSC)
├── TailwindCSS 3.x           # Utility-first styling
├── shadcn/ui                  # Component library (Radix + Tailwind)
│   └── Components in web/src/@/components/ui/
├── Visx                       # Data visualization charts
├── Lucide Icons              # Icon library
├── next-themes               # Dark/light mode
└── tailwind-merge + clsx     # Class composition via cn()

Key files:
├── web/components.json        # shadcn configuration
├── web/src/@/components/ui/   # All shadcn components (you own these!)
├── web/src/@/lib/utils.ts     # cn() helper
└── web/src/styles/globals.css # CSS variables for theming
```

## shadcn/ui Component Reference

Components are copied into your codebase - customize freely.

**Form & Input:** Button, Input, Textarea, Checkbox, Radio Group, Select, Switch, Slider, Calendar, Date Picker, Combobox, Form, Field, Label

**Layout & Navigation:** Accordion, Tabs, Breadcrumb, Navigation Menu, Sidebar, Separator, Scroll Area, Resizable, Collapsible

**Overlays:** Dialog, Alert Dialog, Sheet, Drawer, Popover, Tooltip, Hover Card, Dropdown Menu, Context Menu, Command (cmdk)

**Feedback:** Alert, Toast (Sonner), Progress, Spinner, Skeleton, Badge, Empty

**Display:** Card, Avatar, Table, Data Table, Chart (Recharts), Carousel, Typography, Kbd

### Adding Components

```bash
npx shadcn@latest add button card dialog toast table
```

### Customizing (you own these files!)

```tsx
// web/src/@/components/ui/button.tsx
const buttonVariants = cva("...", {
  variants: {
    variant: {
      default: "bg-primary...",
      accent: "bg-accent shadow-lg shadow-accent/25", // Add custom
      glow: "bg-accent shadow-xl shadow-accent/40",   // Add custom
    },
  },
});
```

### Theming via CSS Variables

Define in `globals.css` - shadcn components use these automatically:

```css
:root {
  --accent: 142 76% 36%;          /* Your signature color */
  --accent-foreground: 0 0% 100%;
  --positive: 142 76% 36%;        /* Custom semantic */
  --negative: 0 84% 60%;          /* Custom semantic */
}
```

Docs: [ui.shadcn.com/docs/theming](https://ui.shadcn.com/docs/theming)

## Design Thinking Process

Before coding, commit to a BOLD aesthetic direction:

1. **Purpose**: What problem does this solve? Who uses it?
2. **Tone**: Pick an extreme aesthetic:
   - Brutally minimal
   - Data-dense/terminal aesthetic
   - Luxury financial (Bloomberg-inspired)
   - Editorial/magazine
   - Retro-futuristic
   - Organic/natural
   - Industrial/utilitarian
   - Art deco/geometric
3. **Differentiation**: What makes this UNFORGETTABLE?

## Typography with Tailwind

### AVOID Generic Fonts
```tsx
// ❌ NEVER - Generic AI slop
className="font-sans"  // Inter, system fonts
className="font-mono"  // Default monospace
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
        // Display fonts - bold, memorable
        display: ["'Clash Display'", ...fontFamily.sans],
        heading: ["'Cabinet Grotesk'", ...fontFamily.sans],
        
        // Body fonts - refined, readable
        body: ["'Satoshi'", ...fontFamily.sans],
        
        // Mono fonts - for data/numbers
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
// Or from Google Fonts:
import { Space_Grotesk, DM_Sans } from "next/font/google";

const displayFont = localFont({
  src: "../fonts/ClashDisplay-Variable.woff2",
  variable: "--font-display",
  display: "swap",
});
```

### Typography Scale
```tsx
// Headlines - make them BOLD
<h1 className="font-display text-6xl md:text-8xl font-bold tracking-tight">
  Short Interest
</h1>

// Subheadings - refined contrast
<h2 className="font-heading text-2xl font-medium text-muted-foreground">
  Australian Market Data
</h2>

// Data numbers - tabular, precise
<span className="font-tabular text-3xl tabular-nums">
  {shortPercent.toFixed(2)}%
</span>
```

## Color Systems

### AVOID Clichéd Palettes
```tsx
// ❌ NEVER - Purple gradients on white
className="bg-gradient-to-r from-purple-500 to-pink-500"

// ❌ NEVER - Generic blue buttons
className="bg-blue-500 hover:bg-blue-600"
```

### CREATE Distinctive Palettes

Define in `globals.css` with CSS variables:
```css
@layer base {
  :root {
    /* Signature accent - pick ONE memorable color */
    --accent: 142 76% 36%;        /* Emerald for gains */
    --accent-muted: 142 40% 90%;
    
    /* Semantic colors */
    --positive: 142 76% 36%;      /* Gains */
    --negative: 0 84% 60%;        /* Losses */
    
    /* Surfaces - create depth */
    --surface-1: 0 0% 100%;
    --surface-2: 220 14% 96%;
    --surface-3: 220 13% 91%;
    
    /* Borders with intention */
    --border-subtle: 220 13% 91%;
    --border-strong: 220 9% 46%;
  }

  .dark {
    /* Dark mode: rich blacks, not gray */
    --background: 224 71% 4%;
    --surface-1: 222 47% 8%;
    --surface-2: 222 47% 11%;
    --surface-3: 222 47% 14%;
    
    /* Accent pops MORE in dark mode */
    --accent: 142 70% 45%;
  }
}
```

Use semantically:
```tsx
// Gains/losses with purpose
<Badge className={cn(
  "font-tabular",
  isPositive 
    ? "bg-positive/10 text-positive border-positive/20" 
    : "bg-negative/10 text-negative border-negative/20"
)}>
  {isPositive ? "+" : ""}{change.toFixed(2)}%
</Badge>
```

## Motion & Animation

### Tailwind Animation Config
```typescript
// tailwind.config.ts
export default {
  theme: {
    extend: {
      animation: {
        "fade-in": "fadeIn 0.5s ease-out",
        "slide-up": "slideUp 0.5s ease-out",
        "slide-in-right": "slideInRight 0.3s ease-out",
        "scale-in": "scaleIn 0.2s ease-out",
        "pulse-subtle": "pulseSubtle 2s ease-in-out infinite",
        "shimmer": "shimmer 2s linear infinite",
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
      },
    },
  },
};
```

### Staggered Reveals (High Impact)
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
            animationFillMode: "forwards" 
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
<Card className={cn(
  "group relative overflow-hidden",
  "transition-all duration-300 ease-out",
  "hover:shadow-xl hover:shadow-accent/5",
  "hover:-translate-y-1",
  "hover:border-accent/50"
)}>
  {/* Background glow on hover */}
  <div className={cn(
    "absolute inset-0 opacity-0 transition-opacity duration-300",
    "bg-gradient-to-br from-accent/5 via-transparent to-transparent",
    "group-hover:opacity-100"
  )} />
  
  {/* Content */}
  <div className="relative z-10">
    {children}
  </div>
</Card>
```

## Backgrounds & Atmosphere

### Grid Patterns
```tsx
// Subtle dot grid background
<div className="absolute inset-0 bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] [background-size:16px_16px] opacity-50" />

// Line grid
<div className="absolute inset-0 bg-[linear-gradient(to_right,#8080800a_1px,transparent_1px),linear-gradient(to_bottom,#8080800a_1px,transparent_1px)] bg-[size:24px_24px]" />
```

### Gradient Meshes
```tsx
<div className="relative overflow-hidden">
  {/* Gradient orbs */}
  <div className="absolute -top-40 -right-40 h-80 w-80 rounded-full bg-accent/20 blur-3xl" />
  <div className="absolute -bottom-40 -left-40 h-80 w-80 rounded-full bg-primary/10 blur-3xl" />
  
  {/* Content */}
  <div className="relative z-10">{children}</div>
</div>
```

### Noise Texture Overlay
```tsx
// Add to globals.css
.noise-overlay {
  background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.65' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E");
  opacity: 0.03;
  pointer-events: none;
}
```

## Layout & Composition

### Break the Grid
```tsx
// Overlapping elements
<div className="relative">
  <Card className="relative z-10">Main content</Card>
  <div className="absolute -bottom-4 -right-4 z-0 h-full w-full rounded-xl bg-accent/10" />
</div>

// Asymmetric layouts
<div className="grid grid-cols-12 gap-6">
  <div className="col-span-7">Large content</div>
  <div className="col-span-5 -mt-12">Offset sidebar</div>
</div>

// Diagonal flow
<section className="relative -skew-y-3 bg-surface-2 py-24">
  <div className="skew-y-3">Content stays straight</div>
</section>
```

### Generous Negative Space
```tsx
// Let content breathe
<section className="py-32 md:py-48">
  <div className="mx-auto max-w-2xl text-center">
    <h2 className="text-5xl font-display font-bold mb-8">
      One powerful statement
    </h2>
    <p className="text-xl text-muted-foreground leading-relaxed">
      Supporting text with room to breathe.
    </p>
  </div>
</section>
```

## Data Visualization (Visx)

### Chart Color Palettes
```tsx
// Distinctive chart colors
const CHART_COLORS = {
  primary: "hsl(var(--accent))",
  secondary: "hsl(var(--primary))",
  muted: "hsl(var(--muted-foreground))",
  grid: "hsl(var(--border-subtle))",
  
  // Categorical palette
  series: [
    "#10b981", // Emerald
    "#3b82f6", // Blue
    "#f59e0b", // Amber
    "#ef4444", // Red
    "#8b5cf6", // Violet
  ],
};

// Gradient fills for area charts
<LinearGradient
  id="area-gradient"
  from={CHART_COLORS.primary}
  to={CHART_COLORS.primary}
  fromOpacity={0.3}
  toOpacity={0}
/>
```

## Component Patterns

### Skeleton Loading with Shimmer
```tsx
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "animate-shimmer rounded-md bg-gradient-to-r",
        "from-muted via-muted-foreground/10 to-muted",
        "bg-[length:200%_100%]",
        className
      )}
    />
  );
}
```

### Glass Morphism Cards
```tsx
<Card className={cn(
  "backdrop-blur-xl bg-background/80",
  "border border-white/10",
  "shadow-xl shadow-black/5"
)}>
```

### Data Tables with Personality
```tsx
<Table>
  <TableHeader>
    <TableRow className="border-b-2 border-accent/20 hover:bg-transparent">
      <TableHead className="font-display font-semibold text-foreground">
        Stock
      </TableHead>
    </TableRow>
  </TableHeader>
  <TableBody>
    {data.map((row, i) => (
      <TableRow 
        key={row.id}
        className={cn(
          "transition-colors",
          i % 2 === 0 ? "bg-muted/30" : "bg-transparent",
          "hover:bg-accent/5"
        )}
      >
        {/* cells */}
      </TableRow>
    ))}
  </TableBody>
</Table>
```

## Anti-Patterns to AVOID

```tsx
// ❌ Generic button
<Button className="bg-blue-500">Click me</Button>

// ✅ Distinctive button
<Button className={cn(
  "bg-accent text-accent-foreground",
  "shadow-lg shadow-accent/25",
  "hover:shadow-xl hover:shadow-accent/30",
  "transition-all duration-200"
)}>
  Click me
</Button>

// ❌ Boring card
<Card className="p-4 border rounded">Content</Card>

// ✅ Card with presence
<Card className={cn(
  "group relative p-6",
  "border-2 border-transparent",
  "bg-gradient-to-br from-surface-1 to-surface-2",
  "hover:border-accent/30",
  "transition-all duration-300"
)}>
  Content
</Card>

// ❌ Plain list
<ul className="space-y-2">{items}</ul>

// ✅ List with visual rhythm
<ul className="divide-y divide-border">
  {items.map((item, i) => (
    <li 
      key={item.id}
      className="py-4 first:pt-0 last:pb-0 animate-fade-in"
      style={{ animationDelay: `${i * 30}ms` }}
    >
      {item}
    </li>
  ))}
</ul>
```

## Remember

- **Commit to a direction**: Bold maximalism OR refined minimalism - both work
- **Every detail matters**: Spacing, shadows, transitions, borders
- **Test in dark mode**: Accents should pop even more
- **Performance**: Prefer CSS animations over JS, use `will-change` sparingly
- **Accessibility**: shadcn/ui is accessible by default (Radix under the hood) - don't break it
- **Own the components**: shadcn components are in YOUR codebase - customize freely


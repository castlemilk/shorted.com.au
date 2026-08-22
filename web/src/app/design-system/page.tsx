import type { Metadata } from "next";
import Link from "next/link";

import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { HousingIcon } from "@/components/housing/housing-icon";
import { HOUSING_ICONS, type HousingIconName } from "@/components/housing/housing-icons.generated";
import { makePriceScale, fmtPriceShort } from "@/lib/housing/price-scale";
import {
  BRAND_TOKENS,
  CHART_TOKENS,
  DONT_RULES,
  DO_RULES,
  RADIUS_SCALE,
  SEMANTIC_TOKENS,
  SURFACE_TOKENS,
  TOKEN_FORMS,
  TYPE_SCALE,
  type Token,
} from "@/lib/design-tokens";

// An internal reference surface, not a marketing page: keep it out of the index
// and out of the sitemap.
export const metadata: Metadata = {
  title: "The Melbourne Terminal — design system",
  description: "Tokens, type, controls and patterns for Shorted.",
  robots: { index: false, follow: false },
};

// Nothing here reads a request or a backend — it is a pure render over the token
// registry, so it prerenders once at build time.
export const dynamic = "force-static";

const swatch = (t: Token, theme: "light" | "dark") =>
  t.form === "hex" ? t[theme] : `hsl(${t[theme]})`;

export default function DesignSystemPage() {
  return (
    <DashboardLayout>
      <div className="mx-auto max-w-[1120px] px-4 pb-24 pt-10">
        <header className="flex flex-col justify-between gap-6 border-b border-border pb-6 sm:flex-row sm:items-end">
          <div>
            <div className="font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">
              Shorted · design system
            </div>
            <h1 className="mt-2 font-serif text-4xl font-semibold leading-[1.05] tracking-tight text-foreground sm:text-[44px]">
              The Melbourne Terminal
            </h1>
            <p className="mt-3 max-w-[70ch] text-[13px] text-muted-foreground [text-wrap:pretty]">
              Institutional-grade market instrumentation that grew up somewhere warm.
              Trading-terminal density and numeric discipline, without the coldness: no navy,
              no steel, no glass. Every neutral tints toward amber, monospace is the
              application face, and the two themes read as two rooms rather than two palettes
              — light mode a daylight desk, dark mode the same desk after hours, lit only by
              phosphor.
            </p>
          </div>
          <div className="shrink-0 font-mono text-[11px] leading-[1.8] text-muted-foreground sm:text-right">
            <div>tokens · type · components</div>
            <div>housing patterns · drill nav</div>
            <div className="text-primary">light + dark</div>
          </div>
        </header>

        {/* ── 1 · Colour ───────────────────────────────────────────────── */}
        <Section n={1} title="Colour">
          <P>
            Semantic tokens live in <Code>src/styles/globals.css</Code>. Every value on this
            page is checked against that file by <Code>design-tokens.test.ts</Code>, so the
            guide cannot drift from what the app ships. There is no pure <Code>#000</Code> or{" "}
            <Code>#fff</Code> anywhere in the system.
          </P>

          <div className="grid gap-6 lg:grid-cols-2">
            <TokenTable label="Light — warm paper" theme="light" tokens={[...SURFACE_TOKENS, ...BRAND_TOKENS]} />
            <TokenTable label="Dark — CRT phosphor" theme="dark" tokens={[...SURFACE_TOKENS, ...BRAND_TOKENS]} />
          </div>

          <div className="mt-5 grid gap-4 lg:grid-cols-3">
            <Card label="Semantic — direction only">
              <div className="flex flex-col gap-2 text-[11.5px]">
                {SEMANTIC_TOKENS.map((t) => (
                  <span key={t.name} className="flex items-center gap-2.5">
                    <span
                      className="h-[22px] w-[22px] shrink-0 rounded border border-border"
                      style={{ background: swatch(t, "light") }}
                    />
                    <span className="min-w-0 flex-1 truncate">{t.role}</span>
                    <span className="shrink-0 font-mono text-muted-foreground">{t.light}</span>
                  </span>
                ))}
              </div>
              <Note>
                The only true red and green in the system, reserved for movement. Two pairs on
                purpose: the bright values are marks, the <Code>-text</Code> values are
                figures — <Code>#22c55e</Code> is 2.23:1 on the light card and fails AA as text.
              </Note>
            </Card>

            <Card label="Chart palette">
              <div className="flex flex-col gap-2 text-[11.5px]">
                {CHART_TOKENS.map((t) => (
                  <span key={t.name} className="flex items-center gap-2.5">
                    <span
                      className="h-[22px] w-[22px] shrink-0 rounded border border-border"
                      style={{ background: swatch(t, "light") }}
                    />
                    <span className="min-w-0 flex-1 truncate">{t.role}</span>
                    <span className="shrink-0 font-mono text-muted-foreground">{t.light}</span>
                  </span>
                ))}
              </div>
              <Note>Warm, and deliberately not the semantic pair. Accents label and alert; they never carry data meaning.</Note>
            </Card>

            <Card label="Price ramp — every drill level">
              <PriceRamp />
              <Note>
                Sequential sqrt Oranges, clamped so the cheapest and dearest both stay legible
                on either theme. One ramp for the national, state and locator maps — and it
                never collides with semantic red/green. Generated here by the same{" "}
                <Code>makePriceScale</Code> the maps call.
              </Note>
            </Card>
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {(Object.keys(TOKEN_FORMS) as Array<keyof typeof TOKEN_FORMS>).map((form) => (
              <div key={form} className="rounded-lg border border-border bg-card p-3.5">
                <div className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-muted-foreground">
                  {form}
                </div>
                <p className="mt-1.5 text-[11.5px] text-muted-foreground [text-wrap:pretty]">
                  {TOKEN_FORMS[form]}
                </p>
              </div>
            ))}
          </div>
        </Section>

        {/* ── 2 · Typography ───────────────────────────────────────────── */}
        <Section n={2} title="Typography">
          <P>
            IBM Plex Mono is the <em>application</em> face — chrome, labels, tables, buttons,
            navigation and every numeral. Newsreader appears only where the product stops
            being an instrument and starts being a publication: page titles, section
            headlines, editorial surfaces. That boundary is the boundary between reading and
            operating, and it is never blurred for decoration.
          </P>
          <div className="overflow-hidden rounded-xl border border-border bg-card">
            {TYPE_SCALE.map((row, i) => (
              <div
                key={row.role}
                className={`grid items-baseline gap-4 px-5 py-4 sm:grid-cols-[130px_minmax(0,1fr)_190px] ${
                  i < TYPE_SCALE.length - 1 ? "border-b border-border" : ""
                }`}
              >
                <span className="font-mono text-[11px] text-muted-foreground">{row.role}</span>
                <span className={`${row.cls} text-foreground`}>{row.sample}</span>
                <span className="font-mono text-[10.5px] text-muted-foreground sm:text-right">
                  {row.spec}
                </span>
              </div>
            ))}
          </div>
        </Section>

        {/* ── 3 · Radius & spacing ─────────────────────────────────────── */}
        <Section n={3} title="Radius &amp; spacing">
          <P>
            Base radius <Code>--radius: 0.375rem</Code>. Corners soften as surfaces grow.
          </P>
          <div className="grid grid-cols-3 gap-3.5 sm:grid-cols-6">
            {RADIUS_SCALE.map((r) => (
              <div key={r.px} className="text-center">
                <div
                  className="h-14 border border-border bg-muted"
                  style={{ borderRadius: `${r.px}px` }}
                />
                <div className="mt-1.5 font-mono text-[10.5px] text-muted-foreground">
                  {r.px}px · {r.use}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-5 flex flex-wrap items-end gap-5 rounded-lg border border-border bg-card px-5 py-4">
            {[
              [6, "6 xs"],
              [8, "8 sm"],
              [12, "12 md"],
              [24, "24 lg"],
            ].map(([px, label]) => (
              <span key={label} className="flex flex-col items-center gap-1.5">
                <span
                  className="bg-primary"
                  style={{ width: `${px as number}px`, height: `${px as number}px` }}
                />
                <span className="font-mono text-[10.5px] text-muted-foreground">{label}</span>
              </span>
            ))}
            <span className="ml-auto max-w-[52ch] text-[11px] text-muted-foreground sm:text-right">
              Cards pad 20px, tiles 12–14px, gutters 24px. Stat boards draw their hairlines on
              the cells themselves, not with a border-coloured background showing through gaps
              — a gap grid leaves a slab of raw border colour whenever the last row does not
              fill the column count, and the column count changes at every breakpoint.
            </span>
          </div>
        </Section>

        {/* ── 4 · Controls ─────────────────────────────────────────────── */}
        <Section n={4} title="Controls">
          <P>
            40px for primary actions, 28–34px for dense chrome — and never below the 24px
            WCAG 2.5.8 floor, which the <Code>.hit-target</Code> utilities enforce without
            costing layout. Mono labels throughout: no sans anywhere in a control.
          </P>
          <div className="flex flex-col gap-5 rounded-xl border border-border bg-card p-5">
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" className="h-10 rounded-md bg-primary px-4 font-mono text-[13px] font-semibold text-primary-foreground">
                Sign in
              </button>
              <button type="button" className="h-10 rounded-md border border-border bg-card px-4 font-mono text-[13px] text-foreground transition-colors hover:bg-muted">
                Open calculators
              </button>
              <button type="button" className="h-10 rounded-md px-4 font-mono text-[13px] text-foreground transition-colors hover:bg-muted">
                Reset filters
              </button>
              <span className="inline-flex h-10 min-w-[220px] items-center rounded-md border border-border bg-background px-3.5 font-mono text-[13px] text-muted-foreground">
                Search New South Wales suburb…
              </span>
              <span className="inline-flex h-8 items-center rounded-md border border-foreground bg-foreground/[0.09] px-2.5 font-mono text-xs font-medium text-foreground">
                Priced only
              </span>
              <span className="inline-flex h-8 items-center rounded-md border border-border px-2.5 font-mono text-xs text-muted-foreground">
                Priced only
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-6 border-t border-border pt-4">
              <span className="flex gap-0.5 rounded-md border border-border bg-muted p-0.5">
                {["1Y", "5Y", "10Y"].map((t) => (
                  <span key={t} className="inline-flex h-6 items-center rounded px-2.5 font-mono text-[11px] text-muted-foreground">
                    {t}
                  </span>
                ))}
                <span className="inline-flex h-6 items-center rounded bg-card px-2.5 font-mono text-[11px] font-semibold text-foreground">
                  All
                </span>
              </span>
              <span className="inline-flex items-center rounded-md border border-border bg-card px-2.5 py-1 text-[11.5px] text-muted-foreground">
                Dearer than
                <span className="mx-1 font-semibold text-primary">96%</span>
                of NSW suburbs
              </span>
              <span className="inline-flex items-center rounded px-1.5 py-0.5 font-mono text-[10.5px] font-medium text-foreground" style={{ background: "hsl(var(--secondary) / 0.28)" }}>
                18th percentile
              </span>
              <span className="text-xs text-foreground">
                Focus ring
                <span className="ml-2 inline-block rounded-md border border-border px-2.5 py-1 ring-2 ring-ring">
                  input
                </span>
              </span>
            </div>
          </div>
        </Section>

        {/* ── 5 · Housing patterns ─────────────────────────────────────── */}
        <Section n={5} title="Housing patterns">
          <P>
            The vocabulary specific to the housing drill-down. Data provenance is a visual
            obligation here, not a footnote: sourcing, as-at dates and licence lines are part
            of the composition. Live on{" "}
            <Link href="/housing/nsw/bondi-beach" className="text-primary hover:text-foreground">
              a suburb profile
            </Link>
            .
          </P>

          <div className="grid gap-5 lg:grid-cols-2">
            <Card label="Icon sprite — warm duotone">
              <Note>
                {Object.keys(HOUSING_ICONS.icons).length} icons on a {HOUSING_ICONS.cell}px-cell
                sheet, metrics and archetypes together. Every housing metric reads by its icon
                first. Rendered at 14 / 22 / 24 / 30px; never recoloured.
              </Note>
              <div className="mt-3 grid grid-cols-11 gap-2">
                {(Object.keys(HOUSING_ICONS.icons) as HousingIconName[]).map((n) => (
                  <HousingIcon key={n} name={n} size={26} title={n} />
                ))}
              </div>
            </Card>

            <Card label="Stat board">
              <Note>
                Icon-left rows on a hairline grid. Replaces the centred icon-over-label tile:
                same data, about 40% less height. A tile with no value is dropped, not paved
                with an em-dash.
              </Note>
              <div className="mt-3 overflow-hidden rounded-lg border border-border bg-card">
                <div className="-mb-px -mr-px grid grid-cols-2">
                  {[
                    ["population", "Population", "11,513", undefined],
                    ["age", "Median age", "33 yrs", undefined],
                    ["income", "Household inc / wk", "$2,795", "▲ 53% vs NSW"],
                    ["rent", "Median rent / wk", "$1,150", "▲ 150% vs NSW"],
                  ].map(([icon, label, value, delta]) => (
                    <div key={label} className="flex gap-2.5 border-b border-r border-border px-3 py-2.5">
                      <HousingIcon name={icon as HousingIconName} size={20} className="mt-0.5 shrink-0" />
                      <div className="min-w-0">
                        <div className="text-[10px] text-muted-foreground">{label}</div>
                        <div className="font-mono text-sm font-semibold tabular-nums text-foreground">{value}</div>
                        {delta ? (
                          <div className="font-mono text-[9.5px] tabular-nums" style={{ color: "var(--semantic-green-text)" }}>
                            {delta}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </Card>

            <Card label="Percentile dial">
              <Note>
                A 180° arc whose value is always a PERCENTILE, so every dial in a row shares
                one scale. Amber above the top third, foreground-toned below, so colour tracks
                the value rather than the metric. Always paired with the population it ranks
                against.
              </Note>
              <div className="mt-3 flex flex-wrap items-center gap-6">
                <Dial pct={94} label="Amenity score" sub="94th of 2,112 NSW suburbs" />
                <Dial pct={31} label="Median house price" sub="31st of 2,433 NSW suburbs" />
              </div>
            </Card>

            <Card label="Comparison bar">
              <Note>
                One amber bar for the place, labelled tick marks for the state and national
                benchmarks. One row instead of three stacked bars — and the ticks are
                full-strength and named, because distinguishing them by opacity alone put the
                national mark at 1.71:1 on the track.
              </Note>
              <div className="mt-4">
                <div className="text-[12.5px] text-foreground">Median house price</div>
                <div className="relative mt-4 h-3.5 rounded bg-muted">
                  <div className="absolute inset-y-0 left-0 w-[97%] rounded bg-primary" />
                  <span className="absolute -top-4 bottom-0 flex flex-col items-center" style={{ left: "36%" }}>
                    <span className="font-mono text-[9px] leading-none text-muted-foreground">NSW</span>
                    <span className="mt-0.5 w-px flex-1 bg-foreground" />
                  </span>
                  <span className="absolute -top-4 bottom-0 flex flex-col items-center" style={{ left: "27%" }}>
                    <span className="font-mono text-[9px] leading-none text-muted-foreground">AU</span>
                    <span className="mt-0.5 w-px flex-1 border-l border-dashed border-foreground" />
                  </span>
                </div>
                <div className="mt-1 flex justify-between font-mono text-[10px] tabular-nums text-muted-foreground">
                  <span>AU $1.27M · NSW $1.38M</span>
                  <span className="font-semibold text-foreground">Bondi Beach $4.45M</span>
                </div>
              </div>
            </Card>
          </div>

          <div className="mt-5 rounded-xl border border-border bg-card p-5">
            <CardLabel>Provenance line</CardLabel>
            <Note>
              Every data surface closes with source, vintage and licence. Attribution is a
              licence obligation, so it is set at full <Code>muted-foreground</Code> and never
              dimmed further with an opacity multiplier — that token is tuned to just clear AA,
              and an <Code>opacity-70</Code> on top spends the whole margin.
            </Note>
            <p className="mt-3 text-[10.5px] text-muted-foreground [text-wrap:pretty]">
              FY2024–25, 2-yr pooled. NSW BOCSAR recorded incidents, adjusted to the ABS Crime
              Victimisation Survey; ABS ERP denominator. Percentile is the population-weighted
              rank among NSW suburbs — higher means more reported crime. Ranks are never
              compared across states, because each police force counts offences under its own
              rules. CC BY 4.0.
            </p>
          </div>
        </Section>

        {/* ── 6 · Rules ────────────────────────────────────────────────── */}
        <Section n={6} title="Rules">
          <div className="grid gap-5 lg:grid-cols-2">
            <div className="rounded-xl border border-border bg-card p-5">
              <div className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color: "hsl(var(--secondary-text))" }}>
                Do
              </div>
              <ul className="mt-3 flex flex-col gap-2 text-xs leading-[1.55] text-foreground">
                {DO_RULES.map((r) => <li key={r}>{r}</li>)}
              </ul>
            </div>
            <div className="rounded-xl border border-border bg-card p-5">
              <div className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-[hsl(var(--accent))]">
                Don&rsquo;t
              </div>
              <ul className="mt-3 flex flex-col gap-2 text-xs leading-[1.55] text-foreground">
                {DONT_RULES.map((r) => <li key={r}>{r}</li>)}
              </ul>
            </div>
          </div>
        </Section>

        <p className="mt-10 text-[11px] text-muted-foreground">
          Token values are read from <Code>src/@/lib/design-tokens.ts</Code> and held against{" "}
          <Code>src/styles/globals.css</Code> by <Code>design-tokens.test.ts</Code>. Icons and
          banners live in <Code>web/public</Code>.
        </p>
      </div>
    </DashboardLayout>
  );
}

function Section({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="mt-11">
      <h2 className="font-serif text-2xl font-semibold tracking-tight text-foreground">
        {n} · {title}
      </h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

const P = ({ children }: { children: React.ReactNode }) => (
  <p className="mb-4 max-w-[80ch] text-[12.5px] text-muted-foreground [text-wrap:pretty]">{children}</p>
);

const Code = ({ children }: { children: React.ReactNode }) => (
  <code className="rounded bg-muted px-1.5 py-px font-mono text-[11.5px] text-foreground">{children}</code>
);

const CardLabel = ({ children }: { children: React.ReactNode }) => (
  <div className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-muted-foreground">{children}</div>
);

const Note = ({ children }: { children: React.ReactNode }) => (
  <p className="mt-2 text-[11.5px] text-muted-foreground [text-wrap:pretty]">{children}</p>
);

function Card({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <CardLabel>{label}</CardLabel>
      {children}
    </div>
  );
}

function TokenTable({ label, theme, tokens }: { label: string; theme: "light" | "dark"; tokens: Token[] }) {
  return (
    <div>
      <div className="mb-2 font-mono text-[10.5px] uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </div>
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        {tokens.map((t, i) => (
          <div
            key={t.name}
            className={`flex items-center gap-3 px-3.5 py-2.5 ${i < tokens.length - 1 ? "border-b border-border" : ""}`}
          >
            <span
              className="h-[30px] w-[30px] shrink-0 rounded border border-border"
              style={{ background: swatch(t, theme) }}
            />
            <span className="min-w-0 flex-1">
              <span className="block font-mono text-xs text-foreground">--{t.name}</span>
              <span className="block truncate text-[11px] text-muted-foreground">{t.role}</span>
            </span>
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{t[theme]}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Six stops off the real map ramp, so this can never drift from the maps. */
function PriceRamp() {
  const max = 3_500_000;
  const scale = makePriceScale(max);
  const stops = [0.02, 0.2, 0.4, 0.6, 0.8, 1].map((t) => scale(t * max));
  return (
    <div className="mt-3">
      <div
        className="h-[26px] rounded"
        style={{ background: `linear-gradient(90deg, ${stops.join(", ")})` }}
      />
      <div className="mt-1.5 flex justify-between font-mono text-[10px] tabular-nums text-muted-foreground">
        <span>{fmtPriceShort(300_000)}</span>
        <span>{fmtPriceShort(1_500_000)}</span>
        <span>{fmtPriceShort(max)}+</span>
      </div>
    </div>
  );
}

function Dial({ pct, label, sub }: { pct: number; label: string; sub: string }) {
  const stroke = pct >= 66 ? "hsl(var(--primary))" : "hsl(var(--foreground) / 0.55)";
  return (
    <span className="flex items-center gap-3">
      <svg viewBox="0 0 44 28" role="img" aria-label={`${label}: ${pct}th percentile`} className="h-8 w-[52px] shrink-0">
        <path d="M4 24 A18 18 0 0 1 40 24" fill="none" stroke="hsl(var(--muted))" strokeWidth="5" strokeLinecap="round" />
        <path d="M4 24 A18 18 0 0 1 40 24" fill="none" stroke={stroke} strokeWidth="5" strokeLinecap="round" pathLength={100} strokeDasharray={`${pct} 100`} />
        <text x="22" y="25" textAnchor="middle" fontSize="11" fontWeight="600" fill="hsl(var(--foreground))" className="font-mono tabular-nums">
          {pct}
        </text>
      </svg>
      <span className="text-[10.5px] text-muted-foreground">
        <span className="block font-mono uppercase tracking-[0.1em]">{label}</span>
        {sub}
      </span>
    </span>
  );
}

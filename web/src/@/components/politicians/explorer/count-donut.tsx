import { AMBER_STEPS } from "@/lib/politics/analytics-palette";
import { ScreenReaderTable } from "@/components/politicians/explorer/screen-reader-table";
import { PoliticsIcon, type PoliticsIconName } from "@/components/politicians/politics-icon";

export interface CountDonutSegment {
  label: string;
  count: number;
  color?: string;
  /**
   * The sprite id for this category, when the caller has one.
   *
   * OPTIONAL BY DESIGN. This is generic kit — it draws register categories on
   * the hub and could draw anything counted elsewhere — so an icon is something
   * a caller may supply, never something this component derives. A folded
   * "Other (n)" segment carries none: it stands for several categories at once,
   * and borrowing one of their icons would name a group after its first member.
   */
  icon?: PoliticsIconName;
}

export interface CountDonutProps {
  segments: CountDonutSegment[];
  centerLabel: string;
  title: string;
}

const RADIUS = 32;
const STROKE = 16;
/**
 * The usable width inside the hole, in viewBox units, less a hair of padding.
 * Everything in the centre is sized to fit THIS, not to a fixed type scale.
 */
const HOLE_WIDTH = 2 * (RADIUS - STROKE / 2) - 4;

/**
 * The ramp has six steps and `index % length` silently reused them: with seven
 * segments the seventh arc came back round to the first one's amber, so two
 * different categories were drawn in the same colour with nothing on screen to
 * tell them apart. Cap the drawn segments at the ramp length and name the
 * remainder instead of repeating a colour.
 */
const MAX_SEGMENTS = AMBER_STEPS.length;

function safeCount(count: number): number {
  return Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
}

function segmentColor(segment: CountDonutSegment, index: number): string {
  return (
    segment.color ?? AMBER_STEPS[index % AMBER_STEPS.length] ?? AMBER_STEPS[0]
  );
}

/**
 * Fold everything past the fifth category into one explicitly-labelled segment.
 *
 * "Other (4)" states how many categories it stands for, so the arc is not a
 * mystery and the count still adds up to the total. The full list survives in
 * the screen-reader table below, which keeps every original category.
 */
function drawnSegments(values: CountDonutSegment[]): CountDonutSegment[] {
  if (values.length <= MAX_SEGMENTS) return values;
  const head = values.slice(0, MAX_SEGMENTS - 1);
  const tail = values.slice(MAX_SEGMENTS - 1);
  const tailCount = tail.reduce((sum, segment) => sum + segment.count, 0);
  return [...head, { label: `Other (${tail.length})`, count: tailCount }];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Size type to the hole rather than to a Tailwind step.
 *
 * `text-xl` inside a 100-unit viewBox is 20 USER UNITS — a five-digit total was
 * about 55 units wide in a 48-unit hole, so realistic corpus numbers ran out
 * over the ring. Advance width per character is approximated at 0.58em for
 * digits (tabular figures) and 0.52em for a mixed-case label; both are generous
 * enough to leave the fitted text inside the hole.
 */
function fitToHole(
  text: string,
  { max, min, per }: { max: number; min: number; per: number },
): { fontSize: number; text: string } {
  if (!text.length) return { fontSize: max, text };
  const ideal = HOLE_WIDTH / (text.length * per);
  const fontSize = clamp(ideal, min, max);
  // Shrinking handled it whenever the ideal size is still legible; only a label
  // that would need type below the floor gets cut, and then it keeps its full
  // text in a `<title>` so nothing is actually lost.
  if (ideal >= min) return { fontSize, text };
  const maxChars = Math.max(1, Math.floor(HOLE_WIDTH / (fontSize * per)));
  return {
    fontSize,
    text: `${text.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`,
  };
}

export function CountDonut({ segments, centerLabel, title }: CountDonutProps) {
  const values = segments.map((segment) => ({
    ...segment,
    count: safeCount(segment.count),
  }));
  const drawn = drawnSegments(values);
  const total = values.reduce((sum, segment) => sum + segment.count, 0);
  const circumference = 2 * Math.PI * RADIUS;
  let offset = 0;
  const ariaDetails = drawn.length
    ? drawn.map((segment) => `${segment.label}: ${segment.count}`).join("; ")
    : "no segments";

  /*
   * THESE NUMBERS ARE viewBox USER UNITS, NOT CSS PIXELS. Do not "fix" them
   * against a px floor.
   *
   * A responsiveness audit on 2026-08-02 reported these donut labels rendering
   * at "5.6 px — unreadable" and filed it as an accessibility defect. That was a
   * measurement artefact, and the trap is worth writing down because it will be
   * re-measured the same way: the audit read `getComputedStyle(text).fontSize`,
   * which for an SVG resolves in the LOCAL coordinate system, BEFORE the viewBox
   * transform. This svg is `viewBox="0 0 100 100"` drawn into a 208 px box
   * (`max-w-52`), so the scale factor is 2.08 and the label that measured
   * "5.64 px" is **~11.7 CSS px on screen** — larger than the 10 px chrome type
   * beside it. Verified: the same audit records `w: 208, h: 208` for these very
   * elements, and it reports an identical 5.64 at 375 px AND at 768 px, which a
   * genuinely viewport-relative size could not do.
   *
   * Raising `min` to a px-looking floor was tried and reverted: it does not make
   * anything bigger, it only pushes `fitToHole` into its truncation branch and
   * clips labels that currently fit whole.
   */
  const totalFit = fitToHole(String(total), { max: 20, min: 8, per: 0.58 });
  const labelFit = fitToHole(centerLabel, { max: 8, min: 4.5, per: 0.52 });

  return (
    <figure className="space-y-2">
      <figcaption className="text-sm font-medium text-foreground">
        {title}
      </figcaption>
      <div className="relative mx-auto aspect-square max-w-52">
        <svg
          viewBox="0 0 100 100"
          role="img"
          aria-label={`${title}. ${ariaDetails}. Total: ${total} ${centerLabel}.`}
          className="h-full w-full"
        >
          <circle
            cx="50"
            cy="50"
            r={RADIUS}
            fill="none"
            stroke="hsl(var(--border))"
            strokeWidth={STROKE}
            className={total > 0 ? "opacity-40" : "opacity-80"}
          />
          <g transform="rotate(-90 50 50)">
            {drawn.map((segment, index) => {
              if (segment.count === 0 || total === 0) return null;
              const length = (segment.count / total) * circumference;
              const dash = `${length} ${circumference - length}`;
              const circle = (
                <circle
                  key={`${segment.label}-${index}`}
                  cx="50"
                  cy="50"
                  r={RADIUS}
                  fill="none"
                  stroke={segmentColor(segment, index)}
                  strokeWidth={STROKE}
                  strokeDasharray={dash}
                  strokeDashoffset={-offset}
                  strokeLinecap="butt"
                />
              );
              offset += length;
              return circle;
            })}
          </g>
          <text
            x="50"
            y="50"
            textAnchor="middle"
            fontSize={totalFit.fontSize}
            className="font-semibold tabular-nums"
            fill="currentColor"
          >
            {totalFit.text}
          </text>
          <text
            x="50"
            y={50 + labelFit.fontSize + 3}
            textAnchor="middle"
            fontSize={labelFit.fontSize}
            className="text-muted-foreground"
            fill="currentColor"
          >
            {labelFit.text === centerLabel ? null : <title>{centerLabel}</title>}
            {labelFit.text}
          </text>
        </svg>
      </div>
      {/*
        A visible key, because the arcs are six steps of ONE hue and the palest
        pair are not separable at this size. Counts sit beside the labels so the
        chart is readable without hovering anything.
      */}
      {drawn.length ? (
        <ul className="flex flex-wrap justify-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          {drawn.map((segment, index) => (
            <li
              key={`legend-${segment.label}-${index}`}
              className="inline-flex max-w-40 items-center gap-1"
              title={segment.label}
            >
              <span
                aria-hidden
                className="inline-block h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: segmentColor(segment, index) }}
              />
              {/*
                THE SWATCH STAYS. The icon says WHICH category and the swatch
                says which arc — six steps of one hue are not separable by name,
                so replacing the swatch with the icon would break the only link
                between a legend row and the ring above it.
              */}
              {segment.icon ? <PoliticsIcon name={segment.icon} size={14} /> : null}
              <span className="truncate">{segment.label}</span>
              <span className="tabular-nums">{segment.count}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {/*
        The table keeps EVERY original category, including the ones folded into
        "Other" above — grouping is a drawing decision, not a reason to withhold
        a count from anyone reading this way.
      */}
      <ScreenReaderTable ariaLabel={`${title} table`}>
        <caption>{title}</caption>
        <thead>
          <tr>
            <th scope="col">Category</th>
            <th scope="col">Count</th>
          </tr>
        </thead>
        <tbody>
          {values.map((segment, index) => (
            <tr key={`${segment.label}-${index}`}>
              <th scope="row">{segment.label}</th>
              <td className="tabular-nums">{segment.count}</td>
            </tr>
          ))}
          <tr>
            <th scope="row">Total</th>
            <td className="tabular-nums">{total}</td>
          </tr>
        </tbody>
      </ScreenReaderTable>
    </figure>
  );
}

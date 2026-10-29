"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { AlertTriangle, Check, Loader2, Search, X } from "lucide-react";

import {
  shortFmt,
  type ChartPeriod,
  type ChartViewId,
} from "~/@/components/charts/chart-views";
import { Button } from "~/@/components/ui/button";
import { DISCORD_PERIODS, DISCORD_VIEWS } from "~/@/lib/discord/commands";
import {
  ASK_FOR_STOCK,
  buildChartMessage,
  notice,
  type StockHit,
  type StockSummary,
} from "~/@/lib/discord/messages";
import {
  BUILT_IN_SETTINGS,
  type DiscordSettings,
} from "~/@/lib/discord/settings";
import { eyebrow } from "~/@/lib/typography";
import { cn } from "~/@/lib/utils";
import {
  previewStock,
  saveDiscordSettings,
  searchDiscordStocks,
  type PreviewSummary,
} from "./actions";
import {
  DISCORD_FONT,
  DiscordActivityFrame,
  DiscordMessage,
} from "./discord-preview";

/**
 * The settings form and its live preview. The preview is built by the bot's
 * own message builder (messages.ts) from the stock's real readings, so what
 * the page shows is what `/chart` posts with these settings.
 */

/** The stock the preview charts while no default is set. */
export const SAMPLE_CODE = "BHP";

const EXPIRED_MESSAGE =
  "This link has expired. Run /settings in Discord for a new one.";

const VIEW_HINTS: Record<ChartViewId, string> = {
  short: "Percent of shares reported short, from ASIC",
  price: "End-of-day share price and volume",
  combined: "Price and short interest on one chart",
};

export interface DiscordSettingsFormProps {
  scope: "guild" | "user";
  initial: DiscordSettings;
  /** The default stock's name, when one is set. */
  initialName?: string;
  /** When the link stops working, in seconds since the epoch. */
  expiresAt: number;
  /** Whether the interactive chart (the Activity) is switched on. */
  activityEnabled: boolean;
}

export function sameSettings(a: DiscordSettings, b: DiscordSettings): boolean {
  return (
    a.code === b.code &&
    a.view === b.view &&
    a.period === b.period &&
    a.interactive === b.interactive
  );
}

/** Minutes the link has left, counted down once the page is in the browser. */
function useMinutesLeft(expiresAt: number): number | null {
  const [left, setLeft] = useState<number | null>(null);
  useEffect(() => {
    const tick = () =>
      setLeft(Math.max(0, Math.ceil((expiresAt * 1000 - Date.now()) / 60_000)));
    tick();
    const timer = setInterval(tick, 15_000);
    return () => clearInterval(timer);
  }, [expiresAt]);
  return left;
}

function toSummary(preview: PreviewSummary): StockSummary {
  return { ...preview, asOf: preview.asOf ? new Date(preview.asOf) : null };
}

/** The readings for the preview's stock, fetched once per stock. */
function useStockSummary(code: string): StockSummary | null {
  const [summaries, setSummaries] = useState<Record<string, StockSummary>>({});
  useEffect(() => {
    if (summaries[code]) return;
    let live = true;
    previewStock(code)
      .then((preview) => {
        if (live && preview) {
          setSummaries((all) => ({ ...all, [code]: toSummary(preview) }));
        }
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [code, summaries]);
  // Until the readings arrive the message carries the code and its chart.
  return summaries[code] ?? null;
}

function Section({
  legend,
  description,
  children,
}: {
  legend: string;
  description: ReactNode;
  children: ReactNode;
}) {
  return (
    <fieldset className="border-t py-6 first:border-t-0 first:pt-0">
      <legend className="float-left w-full text-sm font-semibold">
        {legend}
      </legend>
      <p className="clear-left pt-1 text-sm text-muted-foreground">
        {description}
      </p>
      <div className="mt-4">{children}</div>
    </fieldset>
  );
}

interface Choice<T extends string> {
  id: T;
  label: string;
  /** Read by assistive technology in place of a terse label (1M). */
  name?: string;
  hint?: string;
  disabled?: boolean;
}

/**
 * Native radios drawn as a segmented control: the browser does the arrow
 * keys, the form semantics and the focus order.
 */
function ChoiceGroup<T extends string>({
  name,
  choices,
  value,
  onChange,
  className,
}: {
  name: string;
  choices: Choice<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div className={cn("grid gap-2", className)}>
      {choices.map((choice) => {
        const checked = choice.id === value;
        return (
          <label
            key={choice.id}
            className={cn(
              "relative flex min-h-10 cursor-pointer flex-col justify-center rounded-md border px-3 py-2 text-sm transition-[border-color,box-shadow,background-color] duration-200",
              "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-background",
              checked
                ? "border-primary bg-primary/[0.06] shadow-amber-glow"
                : "border-input hover:border-primary/60",
              choice.disabled &&
                "cursor-not-allowed opacity-50 hover:border-input",
            )}
          >
            <input
              type="radio"
              name={name}
              value={choice.id}
              checked={checked}
              disabled={choice.disabled}
              onChange={() => onChange(choice.id)}
              aria-label={choice.name}
              className="sr-only"
            />
            <span className="flex items-center gap-2 font-medium">
              {choice.label}
              {checked && (
                <Check aria-hidden className="h-4 w-4 text-primary" />
              )}
            </span>
            {choice.hint && (
              <span className="mt-0.5 text-xs text-muted-foreground">
                {choice.hint}
              </span>
            )}
          </label>
        );
      })}
    </div>
  );
}

/**
 * The default stock: the one chosen, and a search to choose another, drawn as
 * a combobox (WAI-ARIA 1.2): typing searches by code or name, the arrow keys
 * walk the results, Enter picks one and Escape closes the list.
 */
function StockPicker({
  code,
  name,
  onChange,
}: {
  code: string | null;
  name?: string;
  onChange: (hit: StockHit | null) => void;
}) {
  const id = useId();
  const listId = `${id}-results`;
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<StockHit[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const q = query.trim();
    const mine = ++seq.current;
    if (!q) {
      setHits([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const timer = setTimeout(() => {
      searchDiscordStocks(q)
        .then((found) => {
          if (mine !== seq.current) return;
          setHits(found);
          setActive(found.length > 0 ? 0 : -1);
        })
        .catch(() => {
          if (mine === seq.current) setHits([]);
        })
        .finally(() => {
          if (mine === seq.current) setLoading(false);
        });
    }, 200);
    return () => clearTimeout(timer);
  }, [query]);

  const pick = (hit: StockHit) => {
    onChange(hit);
    setQuery("");
    setHits([]);
    setOpen(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      if (hits.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((i) => (i + step + hits.length) % hits.length);
    } else if (event.key === "Enter") {
      // Enter in the search picks a result; it never submits the form.
      event.preventDefault();
      const hit = hits[active];
      if (open && hit) pick(hit);
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      setOpen(false);
    }
  };

  const showList = open && query.trim().length > 0;

  return (
    <div className="space-y-3">
      <div className="flex min-h-10 items-center justify-between gap-3 rounded-md border border-dashed px-3 py-2 text-sm">
        {code ? (
          <p className="min-w-0 truncate">
            <span className="font-semibold">{code}</span>
            {name && <span className="text-muted-foreground"> · {name}</span>}
          </p>
        ) : (
          <p className="text-muted-foreground">
            None. A command without a code asks which stock.
          </p>
        )}
        {code && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onChange(null)}
            aria-label={`Remove ${code} as the default stock`}
          >
            <X aria-hidden className="mr-1 h-4 w-4" />
            Remove
          </Button>
        )}
      </div>

      <div className="relative">
        <label htmlFor={`${id}-input`} className="sr-only">
          Search for a stock by code or company name
        </label>
        <Search
          aria-hidden
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
        />
        <input
          id={`${id}-input`}
          type="text"
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={
            showList && active >= 0 ? `${listId}-${active}` : undefined
          }
          autoComplete="off"
          spellCheck={false}
          placeholder={
            code ? "Search for another stock" : "Search a code or company"
          }
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
          className="flex h-10 w-full rounded-md border border-input bg-background py-2 pl-9 pr-9 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        />
        {loading && (
          <Loader2
            aria-hidden
            className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground"
          />
        )}
        <ul
          id={listId}
          role="listbox"
          aria-label="Stocks"
          hidden={!showList}
          className="absolute z-20 mt-1 max-h-72 w-full overflow-auto rounded-md border bg-popover py-1 text-sm text-popover-foreground"
        >
          {hits.map((hit, i) => (
            // The keyboard drives the list from the input (aria-activedescendant),
            // as the combobox pattern has it; an option never takes focus.
            // eslint-disable-next-line jsx-a11y/click-events-have-key-events
            <li
              key={hit.code}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              // Keep focus in the input, so the list does not close first.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => pick(hit)}
              onMouseEnter={() => setActive(i)}
              className={cn(
                "flex cursor-pointer items-baseline gap-3 px-3 py-2",
                i === active && "bg-accent text-accent-foreground",
              )}
            >
              <span className="w-14 shrink-0 font-semibold">{hit.code}</span>
              <span className="min-w-0 flex-1 truncate">{hit.name}</span>
              {typeof hit.shortPct === "number" && (
                <span className="shrink-0 tabular-nums text-xs opacity-80">
                  {shortFmt(hit.shortPct)} short
                </span>
              )}
            </li>
          ))}
          {!loading && hits.length === 0 && (
            <li className="px-3 py-2 text-muted-foreground" role="presentation">
              No ASX stocks match “{query.trim()}”.
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}

function Preview({
  settings,
  name,
  activityEnabled,
}: {
  settings: DiscordSettings;
  name?: string;
  activityEnabled: boolean;
}) {
  const code = settings.code ?? SAMPLE_CODE;
  const summary = useStockSummary(code);
  const state = { code, view: settings.view, period: settings.period };
  const interactive = settings.interactive && activityEnabled;
  const command = settings.code ? "/chart" : `/chart ${SAMPLE_CODE}`;
  const payload = buildChartMessage({
    summary: summary ?? { code, name: settings.code ? name : undefined },
    state,
    activity: activityEnabled,
    now: new Date(),
  });
  const activitySrc = `/embed/discord?${new URLSearchParams(state).toString()}`;

  return (
    <div className="overflow-hidden rounded-lg border bg-[#313338]">
      {!settings.code && (
        <DiscordMessage
          command="/chart"
          payload={notice(ASK_FOR_STOCK)}
          className="border-b border-[#3f4147]"
        />
      )}
      {interactive ? (
        <div className="space-y-3 p-4">
          <p style={DISCORD_FONT} className="text-[13px] text-[#949ba4]">
            <span className="text-[#00a8fc]">{command}</span> opens the
            interactive chart:
          </p>
          <DiscordActivityFrame
            src={activitySrc}
            title={`The interactive chart ${command} opens`}
          />
        </div>
      ) : (
        <DiscordMessage command={command} payload={payload} />
      )}
    </div>
  );
}

export function DiscordSettingsForm({
  scope,
  initial,
  initialName,
  expiresAt,
  activityEnabled,
}: DiscordSettingsFormProps) {
  const [values, setValues] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [names, setNames] = useState<Record<string, string>>(
    initial.code && initialName ? { [initial.code]: initialName } : {},
  );
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<
    { kind: "idle" } | { kind: "saved" } | { kind: "error"; message: string }
  >({ kind: "idle" });
  const [linkExpired, setLinkExpired] = useState(false);
  const minutesLeft = useMinutesLeft(expiresAt);
  const expired = linkExpired || minutesLeft === 0;
  const dirty = !sameSettings(values, saved);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const change = (next: Partial<DiscordSettings>) => {
    setValues((current) => ({ ...current, ...next }));
    setStatus({ kind: "idle" });
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!dirty || saving || expired) return;
    setSaving(true);
    try {
      const result = await saveDiscordSettings(values);
      if (result.ok) {
        setSaved(result.settings);
        setValues(result.settings);
        setStatus({ kind: "saved" });
      } else {
        if (result.expired) setLinkExpired(true);
        setStatus({ kind: "error", message: result.error });
      }
    } catch {
      setStatus({
        kind: "error",
        message: "Couldn't save just now. Try again in a moment.",
      });
    } finally {
      setSaving(false);
    }
  };

  const periodChoices: Choice<ChartPeriod>[] = DISCORD_PERIODS.map((p) => ({
    id: p.id,
    label: p.label,
    name: p.name,
  }));
  const viewChoices: Choice<ChartViewId>[] = DISCORD_VIEWS.map((v) => ({
    id: v.id,
    label: v.label,
    hint: VIEW_HINTS[v.id],
  }));
  const modeChoices: Choice<"message" | "interactive">[] = [
    {
      id: "message",
      label: "A chart message",
      hint: "Posts the chart with its buttons. Anyone in the channel can change the period or view.",
    },
    {
      id: "interactive",
      label: "The interactive chart",
      hint: activityEnabled
        ? "Opens the full chart inside Discord, to scrub, zoom and pin readings."
        : "Not switched on for the app yet.",
      disabled: !activityEnabled,
    },
  ];

  let statusLine: ReactNode = null;
  if (expired) {
    statusLine = (
      <span className="flex items-center gap-2">
        <AlertTriangle aria-hidden className="h-4 w-4 shrink-0 text-accent" />
        {EXPIRED_MESSAGE}
      </span>
    );
  } else if (saving) {
    statusLine = "Saving…";
  } else if (status.kind === "error") {
    statusLine = (
      <span className="flex items-center gap-2">
        <AlertTriangle aria-hidden className="h-4 w-4 shrink-0 text-accent" />
        {status.message}
      </span>
    );
  } else if (dirty) {
    statusLine = "Unsaved changes";
  } else if (status.kind === "saved") {
    statusLine = (
      <span className="flex items-center gap-2">
        <Check aria-hidden className="h-4 w-4 shrink-0 text-primary" />
        Saved. New charts start this way within a minute.
      </span>
    );
  }

  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,560px)]">
      <form onSubmit={onSubmit} noValidate aria-label="Bot settings">
        <Section
          legend="Default stock"
          description={
            <>
              What <code>/stock</code>, <code>/chart</code> and the interactive
              chart open when no code is typed.
            </>
          }
        >
          <StockPicker
            code={values.code}
            name={values.code ? names[values.code] : undefined}
            onChange={(hit) => {
              if (hit) setNames((all) => ({ ...all, [hit.code]: hit.name }));
              change({ code: hit?.code ?? null });
            }}
          />
        </Section>

        <Section
          legend="Chart"
          description="What a chart shows first. The buttons under it switch views."
        >
          <ChoiceGroup
            name="view"
            choices={viewChoices}
            value={values.view}
            onChange={(view) => change({ view })}
            className="sm:grid-cols-3"
          />
        </Section>

        <Section legend="Period" description="How far back a chart starts.">
          <ChoiceGroup
            name="period"
            choices={periodChoices}
            value={values.period}
            onChange={(period) => change({ period })}
            className="grid-cols-5 [&_label]:items-center [&_label]:px-0"
          />
        </Section>

        <Section
          legend="Commands open"
          description={
            activityEnabled ? (
              <>
                What <code>/stock</code> and <code>/chart</code> do. A chart
                message still offers the interactive chart as a button.
              </>
            ) : (
              <>
                The interactive chart is not switched on for the app yet, so
                commands post a chart message.
              </>
            )
          }
        >
          <ChoiceGroup
            name="mode"
            choices={modeChoices}
            value={values.interactive ? "interactive" : "message"}
            onChange={(mode) => change({ interactive: mode === "interactive" })}
            className="sm:grid-cols-2"
          />
        </Section>

        <p className="mt-2 text-xs text-muted-foreground">
          {scope === "guild"
            ? "These apply to everyone in the server."
            : "These apply to you in DMs, and in servers that have not set their own."}{" "}
          {minutesLeft !== null && minutesLeft > 0 && (
            <>
              This link works for {minutesLeft} more{" "}
              {minutesLeft === 1 ? "minute" : "minutes"}.
            </>
          )}
        </p>

        {/* Pinned to the bottom of a phone's screen, where the preview is
            below the form, so a change can be saved from wherever it was made. */}
        <div className="sticky bottom-0 z-10 -mx-4 mt-4 border-t bg-background/95 px-4 pb-2 pt-3 backdrop-blur supports-[backdrop-filter]:bg-background/80 lg:static lg:mx-0 lg:border-t-0 lg:bg-transparent lg:px-0 lg:pt-0 lg:backdrop-blur-none">
          <div className="grid grid-cols-2 gap-3 sm:flex sm:flex-wrap sm:items-center">
            <Button
              type="submit"
              size="lg"
              className="px-3 sm:px-8"
              disabled={!dirty || saving || expired}
            >
              {saving && (
                <Loader2 aria-hidden className="mr-2 h-4 w-4 animate-spin" />
              )}
              Save settings
            </Button>
            <Button
              type="button"
              variant="outline"
              size="lg"
              className="px-3 sm:px-8"
              disabled={sameSettings(values, BUILT_IN_SETTINGS) || expired}
              onClick={() => change(BUILT_IN_SETTINGS)}
            >
              Use the defaults
            </Button>
          </div>
          <p
            role="status"
            aria-live="polite"
            className="mt-2 min-h-5 text-sm text-muted-foreground"
          >
            {statusLine}
          </p>
        </div>
      </form>

      <aside aria-label="Preview" className="lg:sticky lg:top-24 lg:self-start">
        <p className={cn(eyebrow, "mb-3")}>Preview</p>
        <Preview
          settings={values}
          name={values.code ? names[values.code] : undefined}
          activityEnabled={activityEnabled}
        />
        <p className="mt-3 text-xs text-muted-foreground">
          Anything typed in a command still wins:{" "}
          <code>/chart BHP view:price</code> is BHP&apos;s price whatever is set
          here.
        </p>
      </aside>
    </div>
  );
}

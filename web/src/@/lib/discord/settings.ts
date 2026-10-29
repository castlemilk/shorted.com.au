import {
  isChartViewId,
  type ChartPeriod,
  type ChartViewId,
} from "~/@/components/charts/chart-views";
import {
  DEFAULT_CHART_PERIOD,
  DEFAULT_CHART_VIEW,
} from "~/@/lib/embed/snippet";
import type { Interaction } from "./api";
import { DISCORD_PERIODS } from "./commands";
import { normalizeCode } from "./custom-id";

/**
 * What a server, or a person, can change about the bot: which stock it opens
 * when none is named, how a chart starts out, and whether a command posts a
 * chart message or opens the interactive chart (the Activity).
 *
 * Settings are layered: a server's (set by its members with Manage Server)
 * apply in that server; a person's own apply in DMs and group DMs, and in a
 * server that has none of its own; the built-in defaults fill the rest. What
 * someone types in a command (`/chart BHP view:price`) beats all three.
 *
 * Pure and browser-safe: the settings page's form uses it too.
 */
export interface DiscordSettings {
  /** The stock a command or the Activity opens when none is named; null asks. */
  code: string | null;
  view: ChartViewId;
  /** One of the chart message's period buttons (DISCORD_PERIODS). */
  period: ChartPeriod;
  /** Commands open the interactive chart instead of posting a chart message. */
  interactive: boolean;
}

export const BUILT_IN_SETTINGS: DiscordSettings = {
  code: null,
  view: DEFAULT_CHART_VIEW,
  period: DEFAULT_CHART_PERIOD,
  interactive: false,
};

export type SettingsScope =
  | { kind: "guild"; id: string }
  | { kind: "user"; id: string };

const SNOWFLAKE = /^\d{15,22}$/;

export function isSnowflake(value: unknown): value is string {
  return typeof value === "string" && SNOWFLAKE.test(value);
}

export function isSettingsPeriod(value: unknown): value is ChartPeriod {
  return DISCORD_PERIODS.some((p) => p.id === value);
}

/**
 * The settings in a stored document or a submitted form: each field kept only
 * when it is valid, so a bad field falls back to the next layer instead of
 * breaking a chart.
 */
export function parseSettings(raw: unknown): Partial<DiscordSettings> {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const out: Partial<DiscordSettings> = {};
  if (r.code === null) out.code = null;
  else if (typeof r.code === "string") {
    const code = normalizeCode(r.code);
    if (code) out.code = code;
  }
  if (isChartViewId(r.view)) out.view = r.view;
  if (isSettingsPeriod(r.period)) out.period = r.period;
  if (typeof r.interactive === "boolean") out.interactive = r.interactive;
  return out;
}

/** The first layer that sets a field wins; the built-in defaults fill the rest. */
export function resolveSettings(
  ...layers: (Partial<DiscordSettings> | null | undefined)[]
): DiscordSettings {
  const out = { ...BUILT_IN_SETTINGS };
  for (const key of Object.keys(out) as (keyof DiscordSettings)[]) {
    const layer = layers.find((l) => l && l[key] !== undefined);
    if (layer) (out as Record<string, unknown>)[key] = layer[key];
  }
  return out;
}

/** Who acted: the member in a server, the user in a DM. */
export function actingUserId(interaction: Interaction): string | null {
  const id = interaction.member?.user?.id ?? interaction.user?.id;
  return isSnowflake(id) ? id : null;
}

const ADMINISTRATOR = 1n << 3n;
const MANAGE_GUILD = 1n << 5n;

/**
 * Whether the member may change the server's settings: Manage Server, or
 * Administrator. Discord computes `member.permissions` for the channel and
 * signs the interaction it arrives in, so it can be trusted as given.
 */
export function canManageGuild(interaction: Interaction): boolean {
  const raw = interaction.member?.permissions;
  if (!interaction.guild_id || !raw || !/^\d+$/.test(raw)) return false;
  const permissions = BigInt(raw);
  return (
    (permissions & ADMINISTRATOR) !== 0n || (permissions & MANAGE_GUILD) !== 0n
  );
}

/** The layers that apply to an interaction, server first. */
export function settingsScopes(interaction: Interaction): SettingsScope[] {
  const scopes: SettingsScope[] = [];
  if (isSnowflake(interaction.guild_id)) {
    scopes.push({ kind: "guild", id: interaction.guild_id });
  }
  const user = actingUserId(interaction);
  if (user) scopes.push({ kind: "user", id: user });
  return scopes;
}

export function scopeKey(scope: SettingsScope): string {
  return `${scope.kind}:${scope.id}`;
}

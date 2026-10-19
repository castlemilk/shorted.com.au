import {
  ApplicationCommandOptionType,
  ApplicationIntegrationType,
  InteractionContextType,
} from "./api";
import type {
  ChartPeriod,
  ChartViewId,
} from "~/@/components/charts/chart-views";

/**
 * The bot's slash commands, as Discord's application command JSON. This list
 * is what `npm run discord:register` uploads and what the endpoint routes on,
 * so a command cannot be registered without a handler or handled without
 * being registered (commands.test.ts holds both).
 */

/**
 * The periods a chart message offers: one row of five buttons, Discord's
 * limit per row. Two years is left out; it sits between a year and the full
 * history, and both are a tap away. The chart pages still draw it.
 */
export const DISCORD_PERIODS: readonly {
  id: ChartPeriod;
  label: string;
  name: string;
}[] = [
  { id: "1m", label: "1M", name: "1 month" },
  { id: "3m", label: "3M", name: "3 months" },
  { id: "6m", label: "6M", name: "6 months" },
  { id: "1y", label: "1Y", name: "1 year" },
  { id: "max", label: "Max", name: "All history" },
];

export const DISCORD_VIEWS: readonly {
  id: ChartViewId;
  label: string;
  name: string;
}[] = [
  { id: "short", label: "Short interest", name: "Short interest" },
  { id: "price", label: "Price", name: "Share price and volume" },
  { id: "combined", label: "Combined", name: "Price and short interest" },
];

export const TOP_DEFAULT_COUNT = 10;
export const TOP_MAX_COUNT = 25;

export const COMMAND_NAMES = [
  "stock",
  "chart",
  "search",
  "top",
  "help",
] as const;
export type CommandName = (typeof COMMAND_NAMES)[number];

export function isCommandName(name: unknown): name is CommandName {
  return (
    typeof name === "string" &&
    (COMMAND_NAMES as readonly string[]).includes(name)
  );
}

const codeOption = {
  type: ApplicationCommandOptionType.STRING,
  name: "code",
  description: "ASX code or company name, e.g. BHP or Pilbara",
  required: true,
  autocomplete: true,
  max_length: 60,
};

const viewOption = {
  type: ApplicationCommandOptionType.STRING,
  name: "view",
  description: "What to chart (default: short interest)",
  choices: DISCORD_VIEWS.map((v) => ({ name: v.name, value: v.id })),
};

const periodOption = {
  type: ApplicationCommandOptionType.STRING,
  name: "period",
  description: "How far back (default: 1 year)",
  choices: DISCORD_PERIODS.map((p) => ({ name: p.name, value: p.id })),
};

/**
 * Installable to a server and to a user's own account, and usable in servers,
 * in a DM with the bot and in group DMs, so a member can pull a chart into a
 * server that has not added the bot (when the server allows external apps).
 */
const everywhere = {
  integration_types: [
    ApplicationIntegrationType.GUILD_INSTALL,
    ApplicationIntegrationType.USER_INSTALL,
  ],
  contexts: [
    InteractionContextType.GUILD,
    InteractionContextType.BOT_DM,
    InteractionContextType.PRIVATE_CHANNEL,
  ],
};

export const COMMANDS: readonly ({ name: CommandName } & Record<
  string,
  unknown
>)[] = [
  {
    name: "stock",
    description:
      "A stock's short interest, with a chart you can change in place",
    options: [codeOption],
    ...everywhere,
  },
  {
    name: "chart",
    description: "Chart an ASX stock: short interest, share price, or both",
    options: [codeOption, viewOption, periodOption],
    ...everywhere,
  },
  {
    name: "search",
    description: "Search ASX stocks by code or company name",
    options: [
      {
        type: ApplicationCommandOptionType.STRING,
        name: "query",
        description: "A code or part of a company name",
        required: true,
        max_length: 60,
      },
    ],
    ...everywhere,
  },
  {
    name: "top",
    description: "The most shorted ASX stocks in the latest ASIC data",
    options: [
      {
        type: ApplicationCommandOptionType.INTEGER,
        name: "count",
        description: `How many (default ${TOP_DEFAULT_COUNT})`,
        min_value: 5,
        max_value: TOP_MAX_COUNT,
      },
    ],
    ...everywhere,
  },
  {
    name: "help",
    description: "What the Shorted bot can do",
    ...everywhere,
  },
];

/** Application command type of the Activity's launcher command. */
export const PRIMARY_ENTRY_POINT = 4;

const ENTRY_POINT_FIELDS = [
  "id",
  "type",
  "name",
  "description",
  "handler",
  "integration_types",
  "contexts",
] as const;

/**
 * The body for Discord's bulk overwrite (PUT .../commands), which replaces
 * every command the app has. Enabling Activities gives the app an Entry Point
 * command (type 4, "Launch") that Discord made, not us; an overwrite that
 * leaves it out is refused, so it is carried over with the fields it was
 * created with.
 */
export function registrationPayload(
  existing: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  const entryPoints = existing
    .filter((c) => c.type === PRIMARY_ENTRY_POINT)
    .map((c) =>
      Object.fromEntries(
        ENTRY_POINT_FIELDS.filter((k) => c[k] !== undefined).map((k) => [
          k,
          c[k],
        ]),
      ),
    );
  return [...COMMANDS, ...entryPoints];
}

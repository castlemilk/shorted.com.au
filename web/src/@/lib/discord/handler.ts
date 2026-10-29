import {
  InteractionResponseType,
  InteractionType,
  LIMITS,
  MessageFlags,
  type Interaction,
  type InteractionResponse,
  type MessagePayload,
} from "./api";
import {
  DISCORD_PERIODS,
  DISCORD_VIEWS,
  TOP_DEFAULT_COUNT,
  TOP_MAX_COUNT,
  isCommandName,
} from "./commands";
import { normalizeCode, parseCustomId, type ChartState } from "./custom-id";
import type { DiscordData } from "./data";
import {
  ASK_FOR_STOCK,
  buildChartMessage,
  buildHelpMessage,
  buildSearchMessage,
  buildSettingsMessage,
  buildTopMessage,
  notice,
  toAutocompleteChoices,
  type StockSummary,
} from "./messages";
import type { DiscordRest } from "./rest";
import {
  BUILT_IN_SETTINGS,
  actingUserId,
  canManageGuild,
  isSnowflake,
  resolveSettings,
  settingsScopes,
  type DiscordSettings,
  type SettingsScope,
} from "./settings";
import { SETTINGS_LINK_TTL_S, type SettingsGrant } from "./settings-link";
import type { SettingsStore } from "./settings-store";

/**
 * Routes one verified interaction to its response.
 *
 * Discord waits three seconds for a response and then tells the user the
 * interaction failed. A reply that needs data is therefore raced against
 * `fastPathMs`: ready in time, it is the response itself; not ready, the
 * response is a deferral ("Shorted is thinking…", or for a button, nothing
 * visible) and the reply is delivered over the interaction's webhook once it
 * lands, kept alive past the response by `waitUntil`.
 */

export interface HandlerDeps {
  data: DiscordData;
  rest: DiscordRest;
  /** Offer and launch the Activity (the app must have Activities enabled). */
  activityEnabled: boolean;
  now: () => Date;
  /** Keeps background work alive after the response is sent. */
  waitUntil: (promise: Promise<unknown>) => void;
  /** How long a reply may take before the interaction is deferred. */
  fastPathMs?: number;
  /** Called once per interaction with what happened, for the event log. */
  onOutcome?: (outcome: Outcome) => void;
  /** Servers' and people's settings (settings-store.ts). */
  settingsStore: SettingsStore;
  /** Hands a command's chart to the Activity it launches (launch.ts). */
  rememberLaunch: (channelId: string, state: ChartState) => Promise<void>;
  /** The signed settings page for a grant, or null when links cannot be signed. */
  settingsUrl: (grant: SettingsGrant) => string | null;
}

export interface Outcome {
  action: string;
  status: "success" | "error";
  delivery: "immediate" | "deferred";
}

/** Leaves Discord's 3s window room for a cold start and the round trip. */
export const DEFAULT_FAST_PATH_MS = 1500;

const SEARCH_RESULTS = 10;

/**
 * How long settings may take to read before the built-ins stand in. A cached
 * read is instant; this bounds a cold one so the reply still makes Discord's
 * window.
 */
export const SETTINGS_BUDGET_MS = 500;
/** How long the hand-off to the Activity may take before it launches anyway. */
const LAUNCH_HANDOFF_MS = 600;

type Mode = "new" | "update";

type Reply =
  | { kind: "now"; action: string; response: InteractionResponse }
  | {
      kind: "message";
      action: string;
      mode: Mode;
      work: Promise<MessagePayload>;
      /** Defer privately: the reply is for the person who asked alone. */
      private?: boolean;
    }
  | {
      /** Interactive mode: open the chart in the Activity, not a message. */
      kind: "launch";
      action: string;
      channelId: string;
      summary: Promise<StockSummary | null>;
      input: string;
      view: ChartState["view"];
      period: ChartState["period"];
    };

const FAILED = "Something went wrong on our side. Try again in a moment.";

/** A response that needs nothing fetched. */
function now(action: string, response: InteractionResponse): Reply {
  return { kind: "now", action, response };
}

/** A note only the person who acted can see. */
function privately(action: string, text: string): Reply {
  return now(action, {
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: notice(text),
  });
}

/** A message that needs data: a new one, or the one a button is on. */
type MessageReply = Extract<Reply, { kind: "message" }>;

function withData(
  action: string,
  mode: Mode,
  work: Promise<MessagePayload>,
  options: { private?: boolean } = {},
): MessageReply {
  return { kind: "message", action, mode, work, ...options };
}

function isEphemeral(message: MessagePayload): boolean {
  return ((message.flags ?? 0) & MessageFlags.EPHEMERAL) !== 0;
}

function option(
  interaction: Interaction,
  name: string,
): string | number | undefined {
  const value = interaction.data?.options?.find((o) => o.name === name)?.value;
  return typeof value === "string" || typeof value === "number"
    ? value
    : undefined;
}

function stringOption(interaction: Interaction, name: string): string {
  const value = option(interaction, name);
  return typeof value === "string" ? value.trim() : "";
}

function viewOption(interaction: Interaction): ChartState["view"] | undefined {
  const raw = stringOption(interaction, "view");
  return DISCORD_VIEWS.find((v) => v.id === raw)?.id;
}

function periodOption(
  interaction: Interaction,
): ChartState["period"] | undefined {
  const raw = stringOption(interaction, "period");
  return DISCORD_PERIODS.find((p) => p.id === raw)?.id;
}

/**
 * A code as typed ("bhp", "$PLS") is read directly; anything else, or a
 * code-shaped word that is not a listed code ("GOLD"), goes through search and
 * takes the best match.
 */
async function resolveStock(
  input: string,
  data: DiscordData,
): Promise<StockSummary | null> {
  const code = normalizeCode(input);
  if (code) {
    const summary = await data.stockSummary(code);
    if (summary) return summary;
  }
  const [hit] = await data.search(input, 1);
  const hitCode = normalizeCode(hit?.code);
  if (!hitCode || hitCode === code) return null;
  return data.stockSummary(hitCode);
}

function chartMessage(
  summary: StockSummary,
  view: ChartState["view"],
  period: ChartState["period"],
  deps: HandlerDeps,
): MessagePayload {
  return buildChartMessage({
    summary,
    state: { code: summary.code, view, period },
    activity: deps.activityEnabled,
    now: deps.now(),
  });
}

function notFound(input: string): MessagePayload {
  return notice(
    `Couldn't find an ASX stock matching “${input.slice(0, 60)}”. Try \`/search\`.`,
  );
}

/**
 * A chart for what was asked: a chart message, or in interactive mode the
 * Activity at that chart. Interactive mode needs a channel to hand the chart
 * over in (launch.ts) and the Activity switched on; without either it posts
 * the message.
 */
function chartReply(
  action: string,
  input: string,
  view: ChartState["view"],
  period: ChartState["period"],
  settings: DiscordSettings,
  interaction: Interaction,
  deps: HandlerDeps,
): Reply {
  if (!input) {
    return privately(action, ASK_FOR_STOCK);
  }
  const summary = resolveStock(input, deps.data);
  const channelId = interaction.channel_id;
  if (settings.interactive && deps.activityEnabled && isSnowflake(channelId)) {
    return { kind: "launch", action, channelId, summary, input, view, period };
  }
  return withData(
    action,
    "new",
    summary.then((s) =>
      s ? chartMessage(s, view, period, deps) : notFound(input),
    ),
  );
}

/**
 * The settings that apply to an interaction, server first (settings.ts). A
 * read that takes longer than SETTINGS_BUDGET_MS is not waited for: the
 * built-ins stand in, and the read still fills the cache for the next one.
 */
async function loadSettings(
  interaction: Interaction,
  deps: HandlerDeps,
): Promise<DiscordSettings> {
  const reads = Promise.all(
    settingsScopes(interaction).map((scope) =>
      deps.settingsStore.get(scope).catch(() => null),
    ),
  );
  const settled = await within(reads, SETTINGS_BUDGET_MS);
  return settled.done ? resolveSettings(...settled.value) : BUILT_IN_SETTINGS;
}

/** Whether routing this interaction reads settings (charts do; nothing else). */
function needsSettings(interaction: Interaction): boolean {
  if (interaction.type === InteractionType.APPLICATION_COMMAND) {
    const name = interaction.data?.name;
    return name === "stock" || name === "chart";
  }
  return parseCustomId(interaction.data?.custom_id)?.kind === "pick";
}

/**
 * `/settings`: privately, the settings now and a signed link to the page that
 * changes them. A server's settings need Manage Server; anyone may change
 * their own.
 */
function settingsReply(interaction: Interaction, deps: HandlerDeps): Reply {
  const action = "command_settings";
  const user = actingUserId(interaction);
  if (!user) {
    return privately(action, "Couldn't tell who asked. Try again.");
  }
  const wanted = stringOption(interaction, "for");
  const guildId = interaction.guild_id;
  const inGuild = isSnowflake(guildId);
  const manages = canManageGuild(interaction);
  if (wanted === "server" && !inGuild) {
    return privately(
      action,
      "There's no server here. Run `/settings` in a server to change its settings, or `/settings for:Just me` for your own.",
    );
  }
  if (wanted === "server" && !manages) {
    return privately(
      action,
      "Changing this server's settings needs the **Manage Server** permission. `/settings for:Just me` changes your own.",
    );
  }
  const scope: SettingsScope =
    inGuild && wanted !== "me" && manages
      ? { kind: "guild", id: guildId }
      : { kind: "user", id: user };
  const nowS = Math.floor(deps.now().getTime() / 1000);
  const url = deps.settingsUrl({
    scope,
    by: user,
    expiresAt: nowS + SETTINGS_LINK_TTL_S,
  });
  if (!url) {
    return privately(
      action,
      "Settings can't be changed right now. Try again later.",
    );
  }
  return withData(
    action,
    "new",
    deps.settingsStore
      .get(scope)
      .catch(() => null)
      .then((stored) =>
        buildSettingsMessage({
          scope: scope.kind,
          settings: resolveSettings(stored),
          url,
          minutes: SETTINGS_LINK_TTL_S / 60,
        }),
      ),
    { private: true },
  );
}

function routeCommand(
  interaction: Interaction,
  deps: HandlerDeps,
  settings: DiscordSettings,
): Reply {
  const name = interaction.data?.name;
  if (!isCommandName(name)) {
    return privately(
      "command_unknown",
      "That command is not available any more.",
    );
  }
  const action = `command_${name}`;
  switch (name) {
    case "help":
      return now(action, {
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: buildHelpMessage({ activity: deps.activityEnabled }),
      });
    case "stock":
      return chartReply(
        action,
        stringOption(interaction, "code") || (settings.code ?? ""),
        settings.view,
        settings.period,
        settings,
        interaction,
        deps,
      );
    case "chart":
      return chartReply(
        action,
        stringOption(interaction, "code") || (settings.code ?? ""),
        viewOption(interaction) ?? settings.view,
        periodOption(interaction) ?? settings.period,
        settings,
        interaction,
        deps,
      );
    case "settings":
      return settingsReply(interaction, deps);
    case "search": {
      const query = stringOption(interaction, "query");
      if (!query) {
        return privately(
          action,
          "Search for a code or part of a company name.",
        );
      }
      return withData(
        action,
        "new",
        deps.data
          .search(query, SEARCH_RESULTS)
          .then((hits) => buildSearchMessage(query, hits)),
      );
    }
    case "top": {
      const raw = option(interaction, "count");
      const count =
        typeof raw === "number"
          ? Math.min(TOP_MAX_COUNT, Math.max(5, Math.round(raw)))
          : TOP_DEFAULT_COUNT;
      return withData(
        action,
        "new",
        deps.data.topShorts(count).then(buildTopMessage),
      );
    }
  }
}

function routeComponent(
  interaction: Interaction,
  deps: HandlerDeps,
  settings: DiscordSettings,
): Reply {
  const parsed = parseCustomId(interaction.data?.custom_id);
  switch (parsed?.kind) {
    case "chart": {
      const { code, view, period } = parsed.state;
      return withData(
        "component_chart",
        "update",
        deps.data
          .stockSummary(code)
          .then((summary) =>
            summary
              ? chartMessage(summary, view, period, deps)
              : notice(
                  "Couldn't redraw that chart just now. Try again in a moment.",
                ),
          ),
      );
    }
    case "activity":
      return deps.activityEnabled
        ? now("component_activity", {
            type: InteractionResponseType.LAUNCH_ACTIVITY,
          })
        : privately(
            "component_activity",
            "The interactive chart isn't switched on for this bot. Use **Open on Shorted** instead.",
          );
    case "pick": {
      const code = normalizeCode(interaction.data?.values?.[0]);
      return code
        ? chartReply(
            "component_pick",
            code,
            settings.view,
            settings.period,
            settings,
            interaction,
            deps,
          )
        : privately("component_pick", "Pick a stock from the list.");
    }
    default:
      return privately(
        "component_unknown",
        "This control has expired. Run the command again.",
      );
  }
}

async function within<T>(
  promise: Promise<T>,
  ms: number,
): Promise<{ done: true; value: T } | { done: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ done: false }>((resolve) => {
    timer = setTimeout(() => resolve({ done: false }), ms);
  });
  try {
    return await Promise.race([
      promise.then((value) => ({ done: true as const, value })),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function autocomplete(
  interaction: Interaction,
  deps: HandlerDeps,
): Promise<InteractionResponse> {
  const focused = interaction.data?.options?.find((o) => o.focused);
  const query = typeof focused?.value === "string" ? focused.value.trim() : "";
  // Nothing typed yet: offer the most shorted stocks, which is what most
  // people reach for here.
  const limit = LIMITS.autocompleteChoices;
  const lookup = query
    ? deps.data.search(query, limit)
    : deps.data.topShorts(limit);
  const settled = await within(
    lookup.catch(() => []),
    deps.fastPathMs ?? DEFAULT_FAST_PATH_MS,
  );
  const choices = toAutocompleteChoices(settled.done ? settled.value : []);
  // Search found nothing (or was too slow): a code typed in full is still a
  // choice, so a reader who knows the code is never stuck. With matches on
  // offer it would only push a half-typed name ("PIL") above them.
  const typed = normalizeCode(query);
  if (typed && choices.length === 0) {
    choices.push({ name: typed, value: typed });
  }
  return {
    type: InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
    data: { choices },
  };
}

function respondNow(mode: Mode, message: MessagePayload): InteractionResponse {
  // A note for one person never replaces a message everyone is reading.
  if (mode === "new" || isEphemeral(message)) {
    return {
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: message,
    };
  }
  return { type: InteractionResponseType.UPDATE_MESSAGE, data: message };
}

async function deliverLater(
  interaction: Interaction,
  mode: Mode,
  message: MessagePayload,
  rest: DiscordRest,
  deferredPrivately: boolean,
): Promise<void> {
  const { application_id: app, token } = interaction;
  if (deferredPrivately) {
    // The deferral was private already, so the reply simply replaces it.
    await rest.editOriginal(app, token, { ...message, flags: undefined });
    return;
  }
  if (isEphemeral(message)) {
    // A public "thinking…" cannot be made private: replace it with a private
    // note. On a button, leave the chart as it was.
    if (mode === "new") await rest.deleteOriginal(app, token);
    await rest.followUp(app, token, message);
    return;
  }
  // An edit cannot change a message's visibility; the deferral already set it.
  await rest.editOriginal(app, token, { ...message, flags: undefined });
}

export async function handleInteraction(
  interaction: Interaction,
  deps: HandlerDeps,
): Promise<InteractionResponse> {
  if (interaction.type === InteractionType.PING) {
    return { type: InteractionResponseType.PONG };
  }
  if (interaction.type === InteractionType.APPLICATION_COMMAND_AUTOCOMPLETE) {
    const response = await autocomplete(interaction, deps);
    deps.onOutcome?.({
      action: "autocomplete",
      status: "success",
      delivery: "immediate",
    });
    return response;
  }

  const started = Date.now();
  const fastPathMs = deps.fastPathMs ?? DEFAULT_FAST_PATH_MS;
  const remaining = () => Math.max(0, fastPathMs - (Date.now() - started));

  const settings = needsSettings(interaction)
    ? await loadSettings(interaction, deps)
    : BUILT_IN_SETTINGS;

  let reply =
    interaction.type === InteractionType.APPLICATION_COMMAND
      ? routeCommand(interaction, deps, settings)
      : interaction.type === InteractionType.MESSAGE_COMPONENT
        ? routeComponent(interaction, deps, settings)
        : privately("unsupported", "That isn't something this bot handles.");

  if (reply.kind === "launch") {
    const { action, channelId, input, view, period } = reply;
    const summary = reply.summary.catch((error: unknown) => {
      console.error(`[discord] ${action} lookup failed:`, error);
      return null;
    });
    const settled = await within(summary, remaining());
    if (settled.done) {
      const found = settled.value;
      deps.onOutcome?.({
        action,
        status: "success",
        delivery: "immediate",
      });
      if (!found) {
        return respondNow("new", notFound(input));
      }
      const state = { code: found.code, view, period };
      // Best effort: should the hand-off fail, the Activity opens the
      // server's default stock instead, which still beats no chart.
      await within(
        deps.rememberLaunch(channelId, state).catch((error: unknown) => {
          console.error(`[discord] ${action} hand-off failed:`, error);
        }),
        LAUNCH_HANDOFF_MS,
      );
      return { type: InteractionResponseType.LAUNCH_ACTIVITY };
    }
    // Too slow to launch inside Discord's window (a launch cannot be
    // deferred): post the chart message instead, as a deferred reply.
    reply = withData(
      action,
      "new",
      summary.then((s) =>
        s ? chartMessage(s, view, period, deps) : notFound(input),
      ),
    );
  }

  if (reply.kind === "now") {
    deps.onOutcome?.({
      action: reply.action,
      status: "success",
      delivery: "immediate",
    });
    return reply.response;
  }

  const { action, mode } = reply;
  let failed = false;
  const work = reply.work.catch((error: unknown) => {
    failed = true;
    console.error(`[discord] ${action} failed:`, error);
    return notice(FAILED);
  });
  const settled = await within(work, remaining());
  if (settled.done) {
    deps.onOutcome?.({
      action,
      status: failed ? "error" : "success",
      delivery: "immediate",
    });
    return respondNow(mode, settled.value);
  }

  // A reply for one person (/settings) defers privately, so its "thinking…"
  // is theirs alone and the reply can simply replace it.
  const deferredPrivately = reply.private === true && mode === "new";
  deps.waitUntil(
    work
      .then((message) =>
        deliverLater(interaction, mode, message, deps.rest, deferredPrivately),
      )
      .then(
        () =>
          deps.onOutcome?.({
            action,
            status: failed ? "error" : "success",
            delivery: "deferred",
          }),
        (error: unknown) => {
          console.error(`[discord] ${action} follow-up failed:`, error);
          deps.onOutcome?.({ action, status: "error", delivery: "deferred" });
        },
      ),
  );
  if (mode === "update") {
    return { type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE };
  }
  return deferredPrivately
    ? {
        type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
        data: { flags: MessageFlags.EPHEMERAL },
      }
    : { type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE };
}

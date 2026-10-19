import {
  InteractionResponseType,
  InteractionType,
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
  buildChartMessage,
  buildHelpMessage,
  buildSearchMessage,
  buildTopMessage,
  notice,
  toAutocompleteChoices,
  type StockSummary,
} from "./messages";
import type { DiscordRest } from "./rest";

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
}

export interface Outcome {
  action: string;
  status: "success" | "error";
  delivery: "immediate" | "deferred";
}

/** Leaves Discord's 3s window room for a cold start and the round trip. */
export const DEFAULT_FAST_PATH_MS = 1500;

const SEARCH_RESULTS = 10;

type Mode = "new" | "update";

type Reply =
  | { kind: "now"; action: string; response: InteractionResponse }
  | {
      kind: "message";
      action: string;
      mode: Mode;
      work: Promise<MessagePayload>;
    };

const FAILED = "Something went wrong on our side. Try again in a moment.";

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

function viewOption(interaction: Interaction): ChartState["view"] {
  const raw = stringOption(interaction, "view");
  return DISCORD_VIEWS.find((v) => v.id === raw)?.id ?? "short";
}

function periodOption(interaction: Interaction): ChartState["period"] {
  const raw = stringOption(interaction, "period");
  return DISCORD_PERIODS.find((p) => p.id === raw)?.id ?? "1y";
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

async function chartForInput(
  input: string,
  view: ChartState["view"],
  period: ChartState["period"],
  deps: HandlerDeps,
): Promise<MessagePayload> {
  if (!input)
    return notice("Give me an ASX code or a company name, e.g. `/stock BHP`.");
  const summary = await resolveStock(input, deps.data);
  if (!summary) {
    return notice(
      `Couldn't find an ASX stock matching “${input.slice(0, 60)}”. Try \`/search\`.`,
    );
  }
  return chartMessage(summary, view, period, deps);
}

function routeCommand(interaction: Interaction, deps: HandlerDeps): Reply {
  const name = interaction.data?.name;
  if (!isCommandName(name)) {
    return {
      kind: "now",
      action: "command_unknown",
      response: {
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: notice("That command is not available any more."),
      },
    };
  }
  const action = `command_${name}`;
  switch (name) {
    case "help":
      return {
        kind: "now",
        action,
        response: {
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: buildHelpMessage({ activity: deps.activityEnabled }),
        },
      };
    case "stock":
      return {
        kind: "message",
        action,
        mode: "new",
        work: chartForInput(
          stringOption(interaction, "code"),
          "short",
          "1y",
          deps,
        ),
      };
    case "chart":
      return {
        kind: "message",
        action,
        mode: "new",
        work: chartForInput(
          stringOption(interaction, "code"),
          viewOption(interaction),
          periodOption(interaction),
          deps,
        ),
      };
    case "search": {
      const query = stringOption(interaction, "query");
      return {
        kind: "message",
        action,
        mode: "new",
        work: query
          ? deps.data
              .search(query, SEARCH_RESULTS)
              .then((hits) => buildSearchMessage(query, hits))
          : Promise.resolve(
              notice("Search for a code or part of a company name."),
            ),
      };
    }
    case "top": {
      const raw = option(interaction, "count");
      const count =
        typeof raw === "number"
          ? Math.min(TOP_MAX_COUNT, Math.max(5, Math.round(raw)))
          : TOP_DEFAULT_COUNT;
      return {
        kind: "message",
        action,
        mode: "new",
        work: deps.data.topShorts(count).then((rows) => buildTopMessage(rows)),
      };
    }
  }
}

function routeComponent(interaction: Interaction, deps: HandlerDeps): Reply {
  const parsed = parseCustomId(interaction.data?.custom_id);
  switch (parsed?.kind) {
    case "chart": {
      const { state } = parsed;
      return {
        kind: "message",
        action: "component_chart",
        mode: "update",
        work: deps.data
          .stockSummary(state.code)
          .then((summary) =>
            summary
              ? chartMessage(summary, state.view, state.period, deps)
              : notice(
                  "Couldn't redraw that chart just now. Try again in a moment.",
                ),
          ),
      };
    }
    case "activity":
      return {
        kind: "now",
        action: "component_activity",
        response: deps.activityEnabled
          ? { type: InteractionResponseType.LAUNCH_ACTIVITY }
          : {
              type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
              data: notice(
                "The interactive chart isn't switched on for this bot. Use **Open on Shorted** instead.",
              ),
            },
      };
    case "pick": {
      const code = normalizeCode(interaction.data?.values?.[0]);
      return {
        kind: "message",
        action: "component_pick",
        mode: "new",
        work: code
          ? chartForInput(code, "short", "1y", deps)
          : Promise.resolve(notice("Pick a stock from the list.")),
      };
    }
    default:
      return {
        kind: "now",
        action: "component_unknown",
        response: {
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: notice("This control has expired. Run the command again."),
        },
      };
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
  const lookup = query ? deps.data.search(query, 25) : deps.data.topShorts(25);
  const settled = await within(
    lookup.catch(() => []),
    deps.fastPathMs ?? DEFAULT_FAST_PATH_MS,
  );
  const choices = toAutocompleteChoices(settled.done ? settled.value : []);
  // Search found nothing (or was too slow): a code typed in full is still a
  // choice, so a reader who knows the code is never stuck. With matches on
  // offer it would only push a half-typed name ("PIL") above them.
  const typed = normalizeCode(query);
  if (typed && choices.length === 0)
    choices.push({ name: typed, value: typed });
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
): Promise<void> {
  const { application_id: app, token } = interaction;
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

  const reply: Reply =
    interaction.type === InteractionType.APPLICATION_COMMAND
      ? routeCommand(interaction, deps)
      : interaction.type === InteractionType.MESSAGE_COMPONENT
        ? routeComponent(interaction, deps)
        : {
            kind: "now",
            action: "unsupported",
            response: {
              type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
              data: notice("That isn't something this bot handles."),
            },
          };

  if (reply.kind === "now") {
    deps.onOutcome?.({
      action: reply.action,
      status: "success",
      delivery: "immediate",
    });
    return reply.response;
  }

  let failed = false;
  const work = reply.work.catch((error: unknown) => {
    failed = true;
    console.error(`[discord] ${reply.action} failed:`, error);
    return notice(FAILED);
  });
  const settled = await within(work, deps.fastPathMs ?? DEFAULT_FAST_PATH_MS);
  if (settled.done) {
    deps.onOutcome?.({
      action: reply.action,
      status: failed ? "error" : "success",
      delivery: "immediate",
    });
    return respondNow(reply.mode, settled.value);
  }

  deps.waitUntil(
    work
      .then((message) =>
        deliverLater(interaction, reply.mode, message, deps.rest),
      )
      .then(
        () =>
          deps.onOutcome?.({
            action: reply.action,
            status: failed ? "error" : "success",
            delivery: "deferred",
          }),
        (error: unknown) => {
          console.error(`[discord] ${reply.action} follow-up failed:`, error);
          deps.onOutcome?.({
            action: reply.action,
            status: "error",
            delivery: "deferred",
          });
        },
      ),
  );
  return reply.mode === "new"
    ? { type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE }
    : { type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE };
}

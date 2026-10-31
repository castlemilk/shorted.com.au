/**
 * The slice of Discord's interactions API the Shorted bot uses, as plain
 * constants and types. No discord.js: the bot is an HTTP interactions
 * endpoint (Discord POSTs each interaction to /api/discord/interactions), so
 * it needs a handful of numbers and shapes, not a gateway client.
 *
 * Reference: https://discord.com/developers/docs/interactions/receiving-and-responding
 */

export const DISCORD_API_BASE = "https://discord.com/api/v10";

export const InteractionType = {
  PING: 1,
  APPLICATION_COMMAND: 2,
  MESSAGE_COMPONENT: 3,
  APPLICATION_COMMAND_AUTOCOMPLETE: 4,
  MODAL_SUBMIT: 5,
} as const;

export const InteractionResponseType = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
  /** Components only: acknowledge now, edit the message later. */
  DEFERRED_UPDATE_MESSAGE: 6,
  /** Components only: edit the message the component is attached to. */
  UPDATE_MESSAGE: 7,
  APPLICATION_COMMAND_AUTOCOMPLETE_RESULT: 8,
  /** Open the app's Activity for the user (Activities must be enabled). */
  LAUNCH_ACTIVITY: 12,
} as const;

export const ComponentType = {
  ACTION_ROW: 1,
  BUTTON: 2,
  STRING_SELECT: 3,
} as const;

export const ButtonStyle = {
  PRIMARY: 1,
  SECONDARY: 2,
  SUCCESS: 3,
  DANGER: 4,
  LINK: 5,
} as const;

export const ApplicationCommandOptionType = {
  STRING: 3,
  INTEGER: 4,
} as const;

export const MessageFlags = {
  /** Only the person who invoked the interaction sees the message. */
  EPHEMERAL: 1 << 6,
} as const;

/** Where an app may be installed: a server, or a user's own account. */
export const ApplicationIntegrationType = {
  GUILD_INSTALL: 0,
  USER_INSTALL: 1,
} as const;

/** Where a command may be used. */
export const InteractionContextType = {
  GUILD: 0,
  BOT_DM: 1,
  PRIVATE_CHANNEL: 2,
} as const;

/** Discord's documented limits, enforced by the message builders. */
export const LIMITS = {
  embedTitle: 256,
  embedDescription: 4096,
  embedFieldValue: 1024,
  embedFooter: 2048,
  selectOptions: 25,
  selectOptionLabel: 100,
  autocompleteChoices: 25,
  choiceName: 100,
  attachmentDescription: 1024,
} as const;

export interface CommandOption {
  name: string;
  type: number;
  value?: string | number | boolean;
  /** Set on the option being typed, in an autocomplete interaction. */
  focused?: boolean;
}

export interface Interaction {
  id: string;
  application_id: string;
  type: number;
  token: string;
  data?: {
    /** Slash commands and autocomplete. */
    name?: string;
    options?: CommandOption[];
    /** Message components. */
    custom_id?: string;
    component_type?: number;
    values?: string[];
  };
  guild_id?: string;
  channel_id?: string;
  /** In a server: who acted, and their permissions in this channel. */
  member?: { user?: DiscordUser; permissions?: string };
  /** In a DM or a group DM: who acted. */
  user?: DiscordUser;
  locale?: string;
}

export interface DiscordUser {
  id: string;
  username?: string;
  global_name?: string | null;
}

export interface Embed {
  title?: string;
  url?: string;
  description?: string;
  color?: number;
  fields?: { name: string; value: string; inline?: boolean }[];
  image?: { url: string };
  footer?: { text: string };
}

export interface Button {
  type: typeof ComponentType.BUTTON;
  style: number;
  label?: string;
  custom_id?: string;
  url?: string;
  disabled?: boolean;
}

export interface SelectOption {
  label: string;
  value: string;
  description?: string;
  default?: boolean;
}

export interface StringSelect {
  type: typeof ComponentType.STRING_SELECT;
  custom_id: string;
  placeholder?: string;
  options: SelectOption[];
}

export interface ActionRow {
  type: typeof ComponentType.ACTION_ROW;
  components: (Button | StringSelect)[];
}

/** A file a message uploads; an embed shows it as `attachment://<name>`. */
export interface MessageFile {
  name: string;
  data: Uint8Array;
  contentType: string;
  /** Alt text. */
  description?: string;
}

export interface MessagePayload {
  content?: string;
  embeds?: Embed[];
  components?: ActionRow[];
  flags?: number;
  /**
   * Always empty: the bot echoes what people type (a search query), and a
   * query of "@everyone" must never ping a server.
   */
  allowed_mentions: { parse: [] };
  /**
   * Uploaded with the message (rest.ts sends them as multipart and lists them
   * as the message's attachments, replacing any it had). Only a webhook call
   * can upload: an interaction's HTTP response is JSON, so handler.ts defers
   * every reply that carries files.
   */
  files?: MessageFile[];
}

export interface AutocompleteChoice {
  name: string;
  value: string;
}

export type InteractionResponse =
  | { type: typeof InteractionResponseType.PONG }
  | {
      type:
        | typeof InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE
        | typeof InteractionResponseType.UPDATE_MESSAGE;
      data: MessagePayload;
    }
  | {
      type: typeof InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE;
      data?: { flags?: number };
    }
  | { type: typeof InteractionResponseType.DEFERRED_UPDATE_MESSAGE }
  | {
      type: typeof InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT;
      data: { choices: AutocompleteChoice[] };
    }
  | { type: typeof InteractionResponseType.LAUNCH_ACTIVITY };

/** Cut `text` to `max` characters, ending in an ellipsis when it was cut. */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

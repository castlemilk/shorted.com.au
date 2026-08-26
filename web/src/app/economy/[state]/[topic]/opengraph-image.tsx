/* eslint-disable @next/next/no-img-element, jsx-a11y/alt-text */
import { ImageResponse } from "next/og";

import {
  STATE_NAMES,
  STATE_SLUGS,
  type StateSlug,
} from "~/@/lib/economy/map-metrics";
import {
  economyTopicCopyForState,
  getEconomyTopic,
  isPublishedEconomyTopic,
} from "~/@/lib/economy/topics";
import { OG_CONTENT_TYPE, OG_SIZE, OgCard, getOgLogo } from "~/@/lib/og/card";

export const alt = "Australian state economy topic data — Shorted.com.au";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const revalidate = 86400;

/** Registry-only card: topic Open Graph rendering never loads economic data. */
export default async function Image({
  params,
}: {
  params: Promise<{ state: string; topic: string }>;
}) {
  const { state: stateValue, topic } = await params;
  const state = (STATE_SLUGS as readonly string[]).includes(stateValue)
    ? (stateValue as StateSlug)
    : undefined;
  const definition = getEconomyTopic(topic);
  const published =
    state && definition
      ? isPublishedEconomyTopic(state, definition.slug)
      : false;
  const copy =
    published && state && definition
      ? economyTopicCopyForState(definition, state)
      : undefined;

  return new ImageResponse(
    (
      <OgCard
        eyebrow={state ? `${STATE_NAMES[state]} economy` : "Australian economy"}
        title={copy?.h1 ?? "Australian economy data"}
        subtitle={
          copy?.description ??
          "Official state and territory economic series, source metadata and historical context."
        }
        logoSrc={await getOgLogo()}
      />
    ),
    size,
  );
}

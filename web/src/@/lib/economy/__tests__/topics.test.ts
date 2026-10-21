import {
  ECONOMY_TOPICS,
  ECONOMY_TOPIC_SLUGS,
  PUBLISHED_ECONOMY_TOPIC_PAIRS,
  economyTopicHeadlineKey,
  getEconomyTopic,
} from "../topics";
import { ECONOMY_SERIES_FORMATTERS, STATE_SLUGS } from "../map-metrics";

const EXPECTED_TOPICS = [
  "approvals",
  "business",
  "construction",
  "gdp",
  "labour",
  "lending",
  "population",
  "spending",
  "wages",
] as const;

const words = (copy: string) => copy.trim().split(/\s+/).filter(Boolean);

describe("economy topic registry", () => {
  it("has one unique kebab-case slug for each measured topic", () => {
    expect([...ECONOMY_TOPIC_SLUGS].sort()).toEqual([...EXPECTED_TOPICS].sort());
    expect(new Set(ECONOMY_TOPIC_SLUGS).size).toBe(ECONOMY_TOPIC_SLUGS.length);
    for (const slug of ECONOMY_TOPIC_SLUGS) {
      expect(slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(ECONOMY_TOPICS[slug].slug).toBe(slug);
      expect(ECONOMY_TOPICS[slug].topic).toBe(slug);
      expect(getEconomyTopic(slug)).toBe(ECONOMY_TOPICS[slug]);
    }
    expect(getEconomyTopic("not-a-topic")).toBeUndefined();
  });

  it("publishes only state-topic pairs meeting the measured two-series gate", () => {
    const keys = PUBLISHED_ECONOMY_TOPIC_PAIRS.map(
      ({ state, topic }) => `${topic}|${state}`,
    );

    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).not.toContain("labour|act");
    expect(keys).not.toContain("labour|nt");
    expect(keys).toContain("labour|nsw");

    // Nine topics across eight states, less the two territory labour pages.
    const expectedCount = EXPECTED_TOPICS.length * STATE_SLUGS.length - 2;
    expect(PUBLISHED_ECONOMY_TOPIC_PAIRS).toHaveLength(expectedCount);
  });

  it("provides substantial, mutually distinct explainers", () => {
    const explainers = ECONOMY_TOPIC_SLUGS.map(
      (slug) => ECONOMY_TOPICS[slug].explainer,
    );

    expect(new Set(explainers).size).toBe(explainers.length);
    for (const explainer of explainers) {
      expect(words(explainer).length).toBeGreaterThanOrEqual(120);
    }
  });

  it("provides distinct two-to-three sentence ledes for every published pair", () => {
    const ledes = PUBLISHED_ECONOMY_TOPIC_PAIRS.map(({ state, topic }) => {
      const lede = ECONOMY_TOPICS[topic].ledes[state];
      expect(lede).toBeTruthy();
      const sentenceCount = lede!.match(/[.!?](?:\s|$)/g)?.length ?? 0;
      expect(sentenceCount).toBeGreaterThanOrEqual(2);
      expect(sentenceCount).toBeLessThanOrEqual(3);
      return lede!;
    });

    expect(new Set(ledes).size).toBe(ledes.length);
  });

  it("quotes one series of the topic's own family on the state page", () => {
    for (const { state, topic } of PUBLISHED_ECONOMY_TOPIC_PAIRS) {
      const key = economyTopicHeadlineKey(ECONOMY_TOPICS[topic], state);
      // series_key is topic.metric[.product].region[.adjustment].
      expect(key.startsWith(`${topic}.`)).toBe(true);
      expect(key.split(".")).toContain(state);
      expect(key).not.toMatch(/[{}]/);
    }
    for (const slug of ECONOMY_TOPIC_SLUGS) {
      const { format, sentenceTemplate } = ECONOMY_TOPICS[slug].headline;
      expect(typeof ECONOMY_SERIES_FORMATTERS[format]).toBe("function");
      expect(sentenceTemplate).toContain("{value}");
      expect(sentenceTemplate).toContain("{period}");
      expect(sentenceTemplate).toMatch(/\.$/);
    }
    expect(economyTopicHeadlineKey(ECONOMY_TOPICS.labour, "vic")).toBe(
      "labour.unemployment_rate.total.vic.seasadj",
    );
  });

  it("keeps every registry record JSON-serializable", () => {
    expect(() => JSON.stringify(ECONOMY_TOPICS)).not.toThrow();
    for (const topic of Object.values(ECONOMY_TOPICS)) {
      expect(
        Object.values(topic).some((value) => typeof value === "function"),
      ).toBe(false);
    }
  });

  it("states topic-specific frequency and adjustment caveats accurately", () => {
    expect(ECONOMY_TOPICS.gdp.explainer).toMatch(
      /does not publish a quarterly state GDP flow/i,
    );
    expect(ECONOMY_TOPICS.labour.explainer).toMatch(
      /seasonally adjusted[\s\S]+original job vacancies/i,
    );
    expect(ECONOMY_TOPICS.lending.explainer).toMatch(/quarterly/i);
    expect(ECONOMY_TOPICS.lending.explainer).not.toMatch(/monthly/i);
    expect(ECONOMY_TOPICS.wages.explainer).toMatch(
      /not seasonally adjusted/i,
    );
    expect(ECONOMY_TOPICS.approvals.explainer).not.toMatch(
      /seasonally adjusted/i,
    );
  });
});

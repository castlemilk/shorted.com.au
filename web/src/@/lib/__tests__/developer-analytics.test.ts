/**
 * The developer-surface GA helper.
 *
 * Same two properties that matter for every analytics call site here: a silent
 * no-op when GA is absent, and it must never throw. Plus one that is specific
 * to this surface — a token must never appear in a payload.
 */
import {
  DEVELOPER_EVENTS,
  trackDeveloperEvent,
} from "../developer-analytics";

type GtagWindow = { gtag?: (...args: unknown[]) => void };

afterEach(() => {
  delete (window as GtagWindow).gtag;
});

function installGtag() {
  const gtag = jest.fn();
  (window as GtagWindow).gtag = gtag;
  return gtag;
}

describe("trackDeveloperEvent", () => {
  it("is a no-op when gtag is absent", () => {
    expect(() =>
      trackDeveloperEvent(DEVELOPER_EVENTS.TOKEN_CREATED),
    ).not.toThrow();
  });

  it("does not throw when gtag itself throws", () => {
    (window as GtagWindow).gtag = () => {
      throw new Error("adblocker shim");
    };
    expect(() => trackDeveloperEvent(DEVELOPER_EVENTS.TOKEN_COPIED)).not.toThrow();
  });

  it("sends a fixed surface, never a live pathname", () => {
    const gtag = installGtag();
    trackDeveloperEvent(DEVELOPER_EVENTS.TOKEN_VIEW);

    expect(gtag).toHaveBeenCalledWith("event", "api_token_view", {
      surface: "/developer",
      non_interaction: true,
    });
  });

  it("marks the two clicks as interactions and the rest as not", () => {
    const gtag = installGtag();
    trackDeveloperEvent(DEVELOPER_EVENTS.TOKEN_CREATED);
    trackDeveloperEvent(DEVELOPER_EVENTS.TOKEN_REGENERATED);
    trackDeveloperEvent(DEVELOPER_EVENTS.TOKEN_COPIED);
    trackDeveloperEvent(DEVELOPER_EVENTS.TOKEN_CREATE_FAILED);

    const nonInteraction = gtag.mock.calls.map(
      (c) => (c[2] as { non_interaction: boolean }).non_interaction,
    );
    expect(nonInteraction).toEqual([false, false, false, true]);
  });

  it("carries first_token only when it was supplied", () => {
    const gtag = installGtag();
    trackDeveloperEvent(DEVELOPER_EVENTS.TOKEN_CREATED, { first_token: true });
    trackDeveloperEvent(DEVELOPER_EVENTS.TOKEN_COPIED);

    expect(gtag.mock.calls[0]![2]).toMatchObject({ first_token: true });
    expect(gtag.mock.calls[1]![2]).not.toHaveProperty("first_token");
  });

  it("cannot be made to carry token material — params are a closed shape", () => {
    const gtag = installGtag();
    trackDeveloperEvent(DEVELOPER_EVENTS.TOKEN_COPIED, {
      // @ts-expect-error the params type has no such member; assert at runtime
      // that a stray property is dropped rather than forwarded.
      token: "sk_live_do_not_send_me",
    });

    expect(JSON.stringify(gtag.mock.calls[0]![2])).not.toContain("sk_live");
  });

  it("uses stable event names", () => {
    expect(Object.values(DEVELOPER_EVENTS)).toEqual([
      "api_token_view",
      "api_token_created",
      "api_token_regenerated",
      "api_token_copied",
      "api_token_create_failed",
    ]);
  });
});

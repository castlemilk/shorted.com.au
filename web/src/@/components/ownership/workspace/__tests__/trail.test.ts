/// <reference types="jest" />

import {
  TRAIL_MAX,
  pushTrail,
  readTrail,
  trailHref,
  trailKey,
  writeTrail,
  type TrailStep,
  type TrailStorage,
} from "../trail";

const step = (label: string, href: string): TrailStep => ({ label, href });
const materials = step("Materials", "/ownership/map?sector=Materials");
const bhp = step("BHP Group", "/ownership/map?sector=Materials&sel=stock%3ABHP");
const holder = step("State Street", "/ownership/map?sector=Materials&sel=holder%3Astate-street");
const cba = step("CBA", "/ownership/map?sel=stock%3ACBA");

/** A Storage-like fake: a Map behind getItem and setItem. */
function fakeStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  const storage: TrailStorage & { items: Map<string, string> } = {
    items,
    getItem: (key) => (items.has(key) ? (items.get(key) as string) : null),
    setItem: (key, value) => {
      items.set(key, value);
    },
  };
  return storage;
}

describe("workspace trail (backlog C2)", () => {
  describe("pushTrail", () => {
    it("appends a new step to the end", () => {
      expect(pushTrail([], materials)).toEqual([materials]);
      expect(pushTrail([materials], bhp)).toEqual([materials, bhp]);
      expect(pushTrail([materials, bhp], holder)).toEqual([materials, bhp, holder]);
    });

    it("does not repeat a step whose link is already the last", () => {
      expect(pushTrail([materials, bhp], bhp)).toEqual([materials, bhp]);
      expect(pushTrail([materials], step("Materials again", materials.href))).toEqual([materials]);
    });

    it("cuts the trail back to a step already in it, so walking back and forward does not grow it", () => {
      const walked = pushTrail([materials, bhp, holder], bhp);
      expect(walked).toEqual([materials, bhp]);
      // Walking forward again: the holder's link is no longer in the trail, so it is appended once.
      expect(pushTrail(walked, holder)).toEqual([materials, bhp, holder]);
    });

    it("cuts back to the first step when that is the one walked to", () => {
      expect(pushTrail([materials, bhp, holder], materials)).toEqual([materials]);
    });

    it("keeps at most four steps and drops the oldest", () => {
      expect(TRAIL_MAX).toBe(4);
      const five = pushTrail([materials, bhp, holder, cba], step("Other", "/ownership/map?sel=stock%3AWBC"));
      expect(five.map((s) => s.label)).toEqual(["BHP Group", "State Street", "CBA", "Other"]);
    });

    it("honours a smaller cap", () => {
      expect(pushTrail([materials, bhp], holder, 2)).toEqual([bhp, holder]);
    });

    it("never mutates the trail it is given", () => {
      const before = [materials, bhp];
      const after = pushTrail(before, holder);
      expect(before).toEqual([materials, bhp]);
      expect(after).not.toBe(before);
    });
  });

  describe("readTrail and writeTrail", () => {
    const key = trailKey("/ownership/map");

    it("names its key by the page's path", () => {
      expect(key).toBe("ownership-trail:/ownership/map");
    });

    it("round-trips a trail through storage", () => {
      const storage = fakeStorage();
      writeTrail(storage, key, [materials, bhp, holder]);
      expect(readTrail(storage, key)).toEqual([materials, bhp, holder]);
    });

    it("reads an absent value as an empty trail", () => {
      expect(readTrail(fakeStorage(), key)).toEqual([]);
    });

    it("reads a malformed value as an empty trail, never a partial one", () => {
      expect(readTrail(fakeStorage({ [key]: "{not json" }), key)).toEqual([]);
      expect(readTrail(fakeStorage({ [key]: '{"label":"BHP","href":"/x"}' }), key)).toEqual([]);
      expect(readTrail(fakeStorage({ [key]: '[{"label":"BHP","href":"/x"},{"label":2}]' }), key)).toEqual([]);
      expect(readTrail(fakeStorage({ [key]: '[{"label":"","href":"/x"}]' }), key)).toEqual([]);
    });

    it("refuses a step whose href is not a same-site path", () => {
      const scheme = '[{"label":"BHP","href":"javascript:alert(1)"}]';
      const protocolRelative = '[{"label":"BHP","href":"//evil.example/x"}]';
      const backslash = '[{"label":"BHP","href":"/\\\\evil.example/x"}]';
      expect(readTrail(fakeStorage({ [key]: scheme }), key)).toEqual([]);
      expect(readTrail(fakeStorage({ [key]: protocolRelative }), key)).toEqual([]);
      expect(readTrail(fakeStorage({ [key]: backslash }), key)).toEqual([]);
    });

    it("reads nothing from a storage that is absent or throws", () => {
      expect(readTrail(null, key)).toEqual([]);
      expect(readTrail(undefined, key)).toEqual([]);
      const throwing: TrailStorage = {
        getItem: () => {
          throw new Error("SecurityError");
        },
        setItem: () => {
          throw new Error("QuotaExceededError");
        },
      };
      expect(readTrail(throwing, key)).toEqual([]);
      expect(() => writeTrail(throwing, key, [materials])).not.toThrow();
    });

    it("keeps the newest steps of a stored trail longer than the cap", () => {
      const long = [materials, bhp, holder, cba, step("Other", "/ownership/map?sel=stock%3AWBC")];
      const storage = fakeStorage({ [key]: JSON.stringify(long) });
      expect(readTrail(storage, key).map((s) => s.label)).toEqual(["BHP Group", "State Street", "CBA", "Other"]);
    });

    it("stores only the label and the href of a step", () => {
      const storage = fakeStorage();
      writeTrail(storage, key, [{ ...materials, extra: "x" } as TrailStep]);
      expect(JSON.parse(storage.items.get(key) as string)).toEqual([materials]);
    });
  });

  describe("trailHref", () => {
    it("is the bare path when there is no search", () => {
      expect(trailHref("/ownership/map", "")).toBe("/ownership/map");
    });

    it("keeps the search in a fixed order, so the same state always reads the same", () => {
      expect(trailHref("/ownership/map", "sel=stock%3ABHP&sector=Materials")).toBe(
        "/ownership/map?sector=Materials&sel=stock%3ABHP",
      );
      expect(trailHref("/ownership/map", "sector=Materials&sel=stock%3ABHP")).toBe(
        "/ownership/map?sector=Materials&sel=stock%3ABHP",
      );
    });
  });
});

import { mapStrategy, mapStrategyVersionDetail } from "~/@/lib/strategies/map";
import {
  shortRulesHash,
  versionChipText,
  versionFullText,
  versionStatusNote,
} from "~/@/lib/strategies/versions";
import type { StrategyVersionDef } from "~/@/lib/strategies/types";

const HASH = "3f9a1c2e" + "a".repeat(56);

const V0: StrategyVersionDef = {
  strategyId: "zanger-breakout",
  label: "v0",
  rulesHash: HASH,
  engineVersion: "1.0.0",
  featureSet: "fs1",
  status: "live",
  liveFrom: "",
  kind: "canonical",
  variantId: "",
};

describe("rules version text", () => {
  it("shows the label and the first eight characters of the hash", () => {
    expect(shortRulesHash(HASH)).toBe("3f9a1c2e");
    expect(versionChipText(V0)).toBe("v0 · 3f9a1c2e");
    expect(versionFullText(V0)).toBe("v0 · 3f9a1c2e · engine 1.0.0");
  });

  it("names nothing it does not have", () => {
    expect(versionChipText({ ...V0, label: "", rulesHash: "" })).toBe("");
    expect(versionChipText({ ...V0, label: "", rulesHash: HASH })).toBe(
      "3f9a1c2e",
    );
    expect(versionFullText({ ...V0, engineVersion: "" })).toBe("v0 · 3f9a1c2e");
  });
});

describe("version mapping", () => {
  it("carries the live version on the strategy definition", () => {
    const def = mapStrategy({
      id: "zanger-breakout",
      name: "Zanger",
      version: {
        strategyId: "zanger-breakout",
        label: "v0",
        rulesHash: HASH,
        engineVersion: "1.0.0",
        featureSet: "fs1",
        status: "live",
        kind: "canonical",
      },
    });
    expect(def.version).toEqual(
      expect.objectContaining({ label: "v0", rulesHash: HASH }),
    );
  });

  it("omits the version when the API names none", () => {
    expect(mapStrategy({ id: "canslim" })).not.toHaveProperty("version");
    expect(
      mapStrategy({ id: "canslim", version: { label: "", rulesHash: "" } }),
    ).not.toHaveProperty("version");
  });

  it("maps one changelog entry, its lists and dates, and drops an entry with no version", () => {
    const entry = mapStrategyVersionDetail({
      version: {
        strategyId: "canslim",
        label: "v0",
        rulesHash: HASH,
        status: "superseded",
      },
      policies: ["p1"],
      changes: ["c1"],
      knownIssues: ["k1", "k2"],
      supersededOn: "2026-12-01",
      retiredOn: "not a date",
    });
    expect(entry).toEqual(
      expect.objectContaining({
        policies: ["p1"],
        changes: ["c1"],
        knownIssues: ["k1", "k2"],
        supersededOn: "2026-12-01",
        retiredOn: "",
      }),
    );
    expect(mapStrategyVersionDetail({ policies: ["p"] })).toBeNull();
  });

  it("maps every rule parameter, reading a protojson zero as zero and dropping an unnamed one", () => {
    const entry = mapStrategyVersionDetail({
      version: { strategyId: "canslim", label: "v0", rulesHash: HASH },
      params: [
        { ruleId: "short_interest", name: "min_pct", value: 5 },
        { ruleId: "rs_leader", name: "quantile", value: 0.8 },
        { ruleId: "growth", name: "min_pct" },
        { ruleId: "growth", name: "", value: 1 },
        { ruleId: "growth", name: "bad", value: "NaN" },
      ],
    });
    expect(entry?.params).toEqual([
      { ruleId: "short_interest", name: "min_pct", value: 5 },
      { ruleId: "rs_leader", name: "quantile", value: 0.8 },
      { ruleId: "growth", name: "min_pct", value: 0 },
    ]);
    expect(
      mapStrategyVersionDetail({ version: { label: "v0" } })?.params,
    ).toEqual([]);
  });

  it("reads each rule's role and weight from the canonical spec, dropping a rule with no finite weight", () => {
    const canonicalJson = JSON.stringify({
      rules: [
        { id: "growth", core: true, trigger: false, weight: 0.25 },
        { id: "new_high", core: true, trigger: true, weight: 0.2 },
        { id: "leader", core: false, trigger: false, weight: 0 },
        { id: "no_weight", core: true },
        "not a rule",
      ],
    });
    const entry = mapStrategyVersionDetail({
      version: { strategyId: "canslim", label: "v0", rulesHash: HASH },
      canonicalJson,
    });
    expect(entry?.rules).toEqual([
      { ruleId: "growth", core: true, trigger: false, weight: 0.25 },
      { ruleId: "new_high", core: true, trigger: true, weight: 0.2 },
      { ruleId: "leader", core: false, trigger: false, weight: 0 },
    ]);
    expect(
      mapStrategyVersionDetail({
        version: { label: "v0" },
        canonicalJson: "{not json",
      })?.rules,
    ).toEqual([]);
    expect(
      mapStrategyVersionDetail({ version: { label: "v0" } })?.rules,
    ).toEqual([]);
  });
});

describe("versionStatusNote", () => {
  it("states a draft as not yet live and a superseded version by its date", () => {
    expect(versionStatusNote({ status: "draft" })).toBe("draft: not yet live");
    expect(versionStatusNote({ status: "superseded" }, "2026-11-16")).toBe(
      "superseded 16 November 2026",
    );
    expect(versionStatusNote({ status: "superseded" })).toBe("superseded");
  });

  it("is empty for the live version, which carries its own mark", () => {
    expect(versionStatusNote({ status: "live" }, "")).toBe("");
  });
});

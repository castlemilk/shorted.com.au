import {
  isChartPeriod,
  isChartViewId,
} from "~/@/components/charts/chart-views";
import {
  COMMANDS,
  COMMAND_NAMES,
  DISCORD_PERIODS,
  DISCORD_VIEWS,
  PRIMARY_ENTRY_POINT,
  isCommandName,
  registrationPayload,
} from "../commands";

type Option = {
  name: string;
  description: string;
  choices?: { name: string; value: string }[];
};

describe("COMMANDS", () => {
  it("registers exactly the commands the endpoint handles", () => {
    expect(COMMANDS.map((c) => c.name).sort()).toEqual(
      [...COMMAND_NAMES].sort(),
    );
    for (const command of COMMANDS)
      expect(isCommandName(command.name)).toBe(true);
    expect(isCommandName("movers")).toBe(false);
  });

  it("follows Discord's naming rules", () => {
    for (const command of COMMANDS) {
      expect(command.name).toMatch(/^[a-z0-9_-]{1,32}$/);
      expect((command.description as string).length).toBeLessThanOrEqual(100);
      for (const option of (command.options ?? []) as Option[]) {
        expect(option.name).toMatch(/^[a-z0-9_-]{1,32}$/);
        expect(option.description.length).toBeLessThanOrEqual(100);
      }
    }
  });

  it("offers only views and periods the chart card draws", () => {
    for (const v of DISCORD_VIEWS) expect(isChartViewId(v.id)).toBe(true);
    for (const p of DISCORD_PERIODS) expect(isChartPeriod(p.id)).toBe(true);
    const chart = COMMANDS.find((c) => c.name === "chart")!;
    const options = chart.options as Option[];
    expect(
      options.find((o) => o.name === "view")!.choices!.map((c) => c.value),
    ).toEqual(DISCORD_VIEWS.map((v) => v.id));
    expect(
      options.find((o) => o.name === "period")!.choices!.map((c) => c.value),
    ).toEqual(DISCORD_PERIODS.map((p) => p.id));
  });

  it("fits the periods on one row of buttons", () => {
    expect(DISCORD_PERIODS.length).toBeLessThanOrEqual(5);
  });
});

describe("registrationPayload", () => {
  it("is the command list when the app has no Activity", () => {
    expect(registrationPayload([])).toEqual(COMMANDS);
  });

  it("keeps Discord's Entry Point command, and only its own fields", () => {
    const entryPoint = {
      id: "123",
      application_id: "456",
      version: "789",
      type: PRIMARY_ENTRY_POINT,
      name: "launch",
      description: "Launch an activity",
      handler: 2,
      integration_types: [0, 1],
      contexts: [0, 1, 2],
    };
    const stale = {
      id: "1",
      type: 1,
      name: "old-command",
      description: "gone",
    };
    expect(registrationPayload([stale, entryPoint])).toEqual([
      ...COMMANDS,
      {
        id: "123",
        type: PRIMARY_ENTRY_POINT,
        name: "launch",
        description: "Launch an activity",
        handler: 2,
        integration_types: [0, 1],
        contexts: [0, 1, 2],
      },
    ]);
  });
});

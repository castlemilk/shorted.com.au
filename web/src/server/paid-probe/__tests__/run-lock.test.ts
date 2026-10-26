/** @jest-environment node */
import { runIfIdle } from "../run-lock";

describe("runIfIdle", () => {
  it("refuses a second run while the first is in flight", async () => {
    let finish: (value: string) => void = () => undefined;
    const first = runIfIdle(() => new Promise<string>((resolve) => { finish = resolve; }));

    const second = await runIfIdle(async () => "never");
    expect(second).toEqual({ ran: false });

    finish("done");
    expect(await first).toEqual({ ran: true, value: "done" });
  });

  it("releases the lock after a run, including one that throws", async () => {
    await expect(runIfIdle(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(await runIfIdle(async () => 42)).toEqual({ ran: true, value: 42 });
  });
});

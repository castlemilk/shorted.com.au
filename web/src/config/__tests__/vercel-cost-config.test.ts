import fs from "node:fs";
import path from "node:path";

const webRoot = path.resolve(__dirname, "../../..");
const web = JSON.parse(fs.readFileSync(path.join(webRoot, "vercel.json"), "utf8"));
const root = JSON.parse(fs.readFileSync(path.join(webRoot, "../vercel.json"), "utf8"));

describe("Vercel cost configuration", () => {
  it("keeps all deployment paths on the same Fluid config and cron inventory", () => {
    expect(root.fluid).toBe(true);
    expect(web.fluid).toBe(true);
    expect(root.regions).toEqual(["syd1"]);
    expect(web.regions).toEqual(root.regions);
    expect(web.crons).toEqual(root.crons);
    expect(web.functions).toEqual({ "src/app/**/*": { maxDuration: 15 } });
    expect(root.functions).toEqual(web.functions);
    expect(web.crons.some((cron: { path: string }) => cron.path === "/api/auth/session")).toBe(false);
    // The empty-shell sweep is a backstop for a failed post-deploy re-prime:
    // every shell page heals a runtime empty render by itself
    // (isr-shell-pages.test.ts). Six-hourly, offset three hours from
    // post-deploy-smoke.yml's repair (0 */6), so a repair runs every three.
    expect(web.crons).toContainEqual({ path: "/api/static-pages/warm-cache", schedule: "10 3,9,15,21 * * *" });
    // The About warm wrote two Redis entries with a 300 s TTL once an hour;
    // their readers fill them on a miss.
    expect(web.crons.some((cron: { path: string }) => cron.path === "/api/about/warm-cache")).toBe(false);
    // Keeps the Discord bot's function warm: Discord fails an interaction not
    // answered in three seconds, and a cold start can take most of them. The
    // GET is the bot's status, which reads only config.
    expect(web.crons).toContainEqual({ path: "/api/discord/interactions", schedule: "*/5 * * * *" });
  });
});

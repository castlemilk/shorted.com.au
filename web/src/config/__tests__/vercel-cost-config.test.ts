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
    expect(web.crons).toContainEqual({ path: "/api/static-pages/warm-cache", schedule: "10 * * * *" });
  });
});

/**
 * A robots.txt body split into its user-agent groups (RFC 9309 section 2.2).
 * A crawler obeys exactly one group, the most specific one that names it, so
 * a test that reads a rule must read it from the group a crawler would use,
 * never from the file as a whole: the AI group ends with `Disallow: /` on
 * purpose, and that line says nothing about what Googlebot may fetch.
 */
export interface RobotsGroup {
  /** The user agents named by the group, in file order. */
  agents: string[];
  allows: string[];
  disallows: string[];
  crawlDelay?: number;
}

export function parseRobotsGroups(body: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | undefined;
  // True while reading consecutive User-Agent lines, which share one group.
  let openingAgents = false;

  for (const raw of body.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === "user-agent") {
      if (!current || !openingAgents) {
        current = { agents: [], allows: [], disallows: [] };
        groups.push(current);
        openingAgents = true;
      }
      current.agents.push(value);
      continue;
    }
    openingAgents = false;
    if (!current) continue;
    if (field === "allow") current.allows.push(value);
    else if (field === "disallow") current.disallows.push(value);
    else if (field === "crawl-delay") current.crawlDelay = Number(value);
  }
  return groups;
}

/** The group a crawler with this user-agent token obeys, or the `*` group. */
export function groupFor(groups: RobotsGroup[], agent: string): RobotsGroup | undefined {
  const named = groups.find((g) =>
    g.agents.some((a) => a.toLowerCase() === agent.toLowerCase()),
  );
  return named ?? groups.find((g) => g.agents.includes("*"));
}

/**
 * Whether a group lets a crawler fetch `path`: the longest matching rule wins,
 * an Allow beats a Disallow of the same length, and no match means allowed.
 * `*` matches any run of characters and a trailing `$` anchors the end, as
 * Google and Bing read them.
 */
export function isAllowed(group: RobotsGroup, path: string): boolean {
  const matchLength = (rule: string): number => {
    if (rule === "") return -1;
    const anchored = rule.endsWith("$");
    const pattern = (anchored ? rule.slice(0, -1) : rule)
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    const re = new RegExp(`^${pattern}${anchored ? "$" : ""}`);
    return re.test(path) ? rule.length : -1;
  };
  const bestAllow = Math.max(-1, ...group.allows.map(matchLength));
  const bestDisallow = Math.max(-1, ...group.disallows.map(matchLength));
  if (bestDisallow < 0) return true;
  return bestAllow >= bestDisallow;
}

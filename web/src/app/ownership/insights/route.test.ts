/**
 * @jest-environment node
 */
import { NextRequest } from "next/server";

import { GET } from "./route";

function get(path: string) {
  return GET(new NextRequest(new URL(path, "https://shorted.com.au")));
}

describe("/ownership/insights (retired, spec 14.10)", () => {
  it("answers a 308 to the map with the mapped link for the retired link's parameters", async () => {
    const response = get("/ownership/insights?from=2026-06-01&to=2026-09-01&m=disclosed&sector=Materials&stock=BHP");
    expect(response.status).toBe(308);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.pathname).toBe("/ownership/map");
    expect(location.searchParams.get("lens")).toBe("flow");
    expect(location.searchParams.get("sector")).toBe("Materials");
    expect(location.searchParams.get("sel")).toBe("stock:BHP");
    expect(location.searchParams.get("from")).toBe("2026-06-01");
    expect(location.searchParams.get("to")).toBe("2026-09-01");
    expect(location.searchParams.get("since")).toBe("2026-06-01");
    expect(location.searchParams.get("until")).toBe("2026-09-01");
  });

  it("maps a bare request to the map's index fund lens", () => {
    const response = get("/ownership/insights");
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("https://shorted.com.au/ownership/map?lens=index_flow");
  });

  it("folds a fund window longer than the API serves to its last 364 days, so the map it names loads", () => {
    // 2025-01-01 to 2026-09-01 is 609 days: the API refuses it (366 at most), so the map keeps the end date.
    const response = get("/ownership/insights?from=2025-01-01&to=2026-09-01");
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.searchParams.get("from")).toBe("2025-09-02");
    expect(location.searchParams.get("to")).toBe("2026-09-01");
    expect(location.searchParams.get("window")).toBe("364");
    expect(location.searchParams.get("since")).toBeNull();
    expect(location.searchParams.get("until")).toBeNull();
  });

  it("maps a fund window of 366 days or less as it is, since the API serves it", () => {
    const response = get("/ownership/insights?from=2025-09-01&to=2026-09-01");
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.searchParams.get("from")).toBe("2025-09-01");
    expect(location.searchParams.get("to")).toBe("2026-09-01");
    expect(location.searchParams.get("window")).toBeNull();
  });
});

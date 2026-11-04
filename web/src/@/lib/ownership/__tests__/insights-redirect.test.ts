/// <reference types="jest" />

import { readDeskState } from "~/@/components/ownership/desk/desk-state";
import { insightsRedirectPath, insightsRedirectQuery } from "../insights-redirect";

const q = (search: string) => insightsRedirectQuery(new URLSearchParams(search));

describe("the retired insights link's map query (spec 14.10)", () => {
  it("sends a bare request to the map's index fund lens", () => {
    expect(q("")).toBe("lens=index_flow");
    expect(insightsRedirectPath(new URLSearchParams(""))).toBe("/ownership/map?lens=index_flow");
  });

  it("maps the example link: the fund window, the sector and the stock, with the window as a chip", () => {
    const query = q("from=2026-06-01&to=2026-09-01&m=disclosed&sector=Materials&stock=BHP");
    const state = readDeskState(new URLSearchParams(query));
    // 2026-06-01 to 2026-09-01 is 92 days apart: a served notice pair, so it is also the brushed window.
    expect(state).toMatchObject({
      lens: "flow",
      sector: "Materials",
      sel: "stock:BHP",
      from: "2026-06-01",
      to: "2026-09-01",
      since: "2026-06-01",
      until: "2026-09-01",
    });
    expect(query).toBe(
      "since=2026-06-01&until=2026-09-01&from=2026-06-01&to=2026-09-01&lens=flow&sector=Materials&sel=stock%3ABHP",
    );
  });

  it("maps m=disclosed to the notices' net change, and any other measure to the index fund change", () => {
    expect(readDeskState(new URLSearchParams(q("m=disclosed"))).lens).toBe("flow");
    expect(readDeskState(new URLSearchParams(q("m=funds"))).lens).toBe("index_flow");
    expect(readDeskState(new URLSearchParams(q("m=anything"))).lens).toBe("index_flow");
  });

  it("writes stock=C as the workspace selection, upper-cased, and drops a code the codec would not write", () => {
    expect(readDeskState(new URLSearchParams(q("stock=bhp"))).sel).toBe("stock:BHP");
    expect(readDeskState(new URLSearchParams(q("stock=BH%20P"))).sel).toBe("");
  });

  it("folds a span longer than the served 366 days to the 364 days ending at its end, as the chip window, not a brush", () => {
    const link = new URLSearchParams(q("from=2024-01-01&to=2026-10-31"));
    expect(link.get("window")).toBe("364");
    expect(link.get("since")).toBeNull();
    expect(link.get("until")).toBeNull();
    // The map's fund window is the 364 days ending at the link's end date: a window the API serves.
    expect(link.get("from")).toBe("2025-11-01");
    expect(link.get("to")).toBe("2026-10-31");
    const state = readDeskState(link);
    expect(state.from).toBe("2025-11-01");
    expect(state.to).toBe("2026-10-31");
    expect(state.window).toBe(364);
  });

  it("keeps a span of 366 days or fewer as a served brushed pair, with no chip window", () => {
    const state = readDeskState(new URLSearchParams(q("from=2025-10-19&to=2026-10-20")));
    expect(state.since).toBe("2025-10-19");
    expect(state.until).toBe("2026-10-20");
    expect(state.window).toBe(91);
  });

  it("drops a fund window that is one date alone, an inverted pair or an impossible date", () => {
    for (const search of ["from=2026-06-01", "from=2026-09-01&to=2026-06-01", "from=2026-02-30&to=2026-03-01"]) {
      const state = readDeskState(new URLSearchParams(q(search)));
      expect(state.from).toBe("");
      expect(state.to).toBe("");
      expect(state.since).toBe("");
    }
  });

  it("passes the sector verbatim, the placeholder included", () => {
    expect(readDeskState(new URLSearchParams(q("sector=Other"))).sector).toBe("Other");
    expect(readDeskState(new URLSearchParams(q("sector=Financials"))).sector).toBe("Financials");
  });
});

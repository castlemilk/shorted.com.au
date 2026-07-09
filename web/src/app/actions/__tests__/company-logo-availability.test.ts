import { getVerifiedCompanyLogoUrls } from "../company-logo-availability";

jest.mock("next/cache", () => ({
  unstable_cache: (fn: unknown) => fn,
}));

describe("company logo availability", () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock;
  });

  it("returns verified normalized logo URLs and skips missing tickers", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        items: [
          { name: "logos-normalized/MIN.png" },
          { name: "logos-normalized/LTR.png" },
        ],
      }),
    });

    const urls = await getVerifiedCompanyLogoUrls(["MIN", "ALD", "min"]);

    expect(urls.get("MIN")).toContain("/logos-normalized/MIN.png");
    expect(urls.has("ALD")).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("follows paginated bucket listings", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          nextPageToken: "next-page",
          items: [{ name: "logos-normalized/AAA.png" }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: [{ name: "logos-normalized/BBB.png" }],
        }),
      });

    const urls = await getVerifiedCompanyLogoUrls(["BBB"]);

    expect(urls.get("BBB")).toContain("/logos-normalized/BBB.png");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
      "pageToken=next-page",
    );
  });
});

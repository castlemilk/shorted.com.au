/// <reference types="jest" />
// The council actions' KV last-good layer: an empty (or partial) response is
// never written, and a cached entry that is empty (or partial) is a MISS that
// falls through to a live fetch — never a hit pinned for the 24h TTL (the
// /politicians 2026-07-31 lesson).
import { TextDecoder, TextEncoder } from "util";
import type { CouncilSummary, GetCouncilProfileResponse, ListCouncilsResponse } from "~/gen/shorts/v1alpha1/housing_pb";

if (!globalThis.TextEncoder) globalThis.TextEncoder = TextEncoder;
// @ts-expect-error - Node's TextDecoder type differs from the DOM lib's
if (!globalThis.TextDecoder) globalThis.TextDecoder = TextDecoder;

const getCachedMock = jest.fn();
const setCachedMock = jest.fn();
const clientMock = { listCouncils: jest.fn(), getCouncilProfile: jest.fn() };

// Identity JSON codec (the shared setup's protobuf mock has no toJson, which
// would make every cache write throw inside its try/catch and pass vacuously).
jest.mock("@bufbuild/protobuf", () => ({
  fromJson: (_schema: unknown, data: unknown) => data ?? {},
  toJson: (_schema: unknown, data: unknown) => data ?? {},
  create: (_schema: unknown, data: unknown) => data ?? {},
}));
jest.mock("@connectrpc/connect-web", () => ({ createConnectTransport: () => ({}) }));
jest.mock("@connectrpc/connect", () => ({ createClient: () => clientMock }));
jest.mock("@/lib/kv-cache", () => ({
  CACHE_KEYS: {
    councils: (st: string) => `cache:housing:councils:${st}`,
    councilProfile: (st: string, slug: string) => `cache:housing:council:${st}:${slug}`,
  },
  HOUSING_TTL: 86400,
  PRICE_DROPS_TTL: 300,
  getCached: (...args: unknown[]) => getCachedMock(...args),
  setCached: (...args: unknown[]) => setCachedMock(...args),
}));

const summary = (over: Partial<CouncilSummary> = {}) =>
  ({ lgaCode: "17200", slug: "sydney", displayName: "Sydney", kind: "council", memberSuburbCount: 0, ...over }) as CouncilSummary;
const list = (n: number) => ({ councils: Array.from({ length: n }, () => summary()) }) as unknown as ListCouncilsResponse;
const profile = (memberSuburbCount: number, suburbs: number) =>
  ({
    profile: {
      summary: summary({ memberSuburbCount }),
      suburbs: Array.from({ length: suburbs }, (_, i) => ({ salCode: `1${i}`, salName: "X" })),
    },
  }) as unknown as GetCouncilProfileResponse;

describe("council actions: KV last-good layer", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    getCachedMock.mockResolvedValue(null);
    setCachedMock.mockResolvedValue(undefined);
  });

  it("never writes an empty council list", async () => {
    clientMock.listCouncils.mockResolvedValue(list(0));
    const { listCouncils } = await import("../getHousing");
    await listCouncils("NSW");
    expect(clientMock.listCouncils).toHaveBeenCalledTimes(1);
    expect(setCachedMock).not.toHaveBeenCalled();
  });

  it("writes a populated council list", async () => {
    clientMock.listCouncils.mockResolvedValue(list(2));
    const { listCouncils } = await import("../getHousing");
    await listCouncils("NSW");
    expect(setCachedMock).toHaveBeenCalledWith("cache:housing:councils:NSW", expect.anything(), 86400);
  });

  it("treats a cached empty council list as a miss and fetches live", async () => {
    getCachedMock.mockResolvedValue(list(0));
    clientMock.listCouncils.mockResolvedValue(list(3));
    const { listCouncils } = await import("../getHousing");
    const res = await listCouncils("NSW");
    expect(clientMock.listCouncils).toHaveBeenCalledTimes(1);
    expect(res?.councils).toHaveLength(3);
  });

  it("serves a cached populated council list without a fetch", async () => {
    getCachedMock.mockResolvedValue(list(2));
    const { listCouncils } = await import("../getHousing");
    const res = await listCouncils("NSW");
    expect(clientMock.listCouncils).not.toHaveBeenCalled();
    expect(res?.councils).toHaveLength(2);
  });

  it("never writes a profile whose member suburbs failed to load", async () => {
    clientMock.getCouncilProfile.mockResolvedValue(profile(24, 0));
    const { getCouncilProfile } = await import("../getHousing");
    await getCouncilProfile("NSW", "sydney");
    expect(setCachedMock).not.toHaveBeenCalled();
  });

  it("writes a complete profile, and one with genuinely no member suburbs", async () => {
    clientMock.getCouncilProfile.mockResolvedValueOnce(profile(24, 24)).mockResolvedValueOnce(profile(0, 0));
    const { getCouncilProfile } = await import("../getHousing");
    await getCouncilProfile("NSW", "sydney");
    await getCouncilProfile("NSW", "lord-howe-island");
    expect(setCachedMock).toHaveBeenCalledTimes(2);
  });

  it("treats a cached partial profile as a miss", async () => {
    getCachedMock.mockResolvedValue(profile(24, 0));
    clientMock.getCouncilProfile.mockResolvedValue(profile(24, 24));
    const { getCouncilProfile } = await import("../getHousing");
    const res = await getCouncilProfile("NSW", "sydney");
    expect(clientMock.getCouncilProfile).toHaveBeenCalledTimes(1);
    expect(res?.profile?.suburbs).toHaveLength(24);
  });

  it("keys the cache by the normalised slug, as the API resolves it", async () => {
    clientMock.getCouncilProfile.mockResolvedValue(profile(24, 24));
    const { getCouncilProfile } = await import("../getHousing");
    await getCouncilProfile("NSW", " Sydney ");
    expect(getCachedMock).toHaveBeenCalledWith("cache:housing:council:NSW:sydney");
    expect(clientMock.getCouncilProfile).toHaveBeenCalledWith({ stateCode: "NSW", slug: "sydney" });
  });
});

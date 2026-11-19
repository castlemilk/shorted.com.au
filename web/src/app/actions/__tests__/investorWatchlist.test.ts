import { create } from "@bufbuild/protobuf";
import {
  GetStockOwnershipResponseSchema,
  SubstantialNoticeSchema,
} from "~/gen/shorts/v1alpha1/ownership_pb";
import { getStockOwnership } from "../getOwnership";
import { loadInvestorRegisters } from "../investorWatchlist";

jest.mock("../getOwnership", () => ({ getStockOwnership: jest.fn() }));
const read = jest.mocked(getStockOwnership);
beforeEach(() => read.mockReset());

it("reads each distinct issuer once, returns eligible named notices, and preserves partial register availability", async () => {
  const notice = (stockCode: string, form: string, holderName: string) =>
    create(SubstantialNoticeSchema, {
      stockCode,
      form,
      holderName,
      event: "changed",
      ceased: true,
      hasPresent: true,
      presentPct: 9,
    });
  read.mockImplementation(async (code) => {
    if (code === "BAD") throw new Error("unavailable");
    if (code === "NEW")
      return create(GetStockOwnershipResponseSchema, { asOf: "2026-11-06" });
    return create(GetStockOwnershipResponseSchema, {
      asOf: "2026-11-06",
      summary: { stockCode: "MHC" },
      historyTotal: 120,
      history: [
        notice("MHC", "604", "Named holder"),
        notice("ABC", "603", "Other issuer"),
        notice("MHC", "NZ", "Other form"),
        notice("MHC", "603", "  "),
      ],
    });
  });
  const [mhc, bad, absent] = await loadInvestorRegisters([
    "MHC",
    "BAD",
    "MHC",
    "NEW",
  ]);
  expect(read.mock.calls).toEqual([["MHC"], ["BAD"], ["NEW"]]);
  expect(mhc).toMatchObject({
    code: "MHC",
    asOf: "2026-11-06",
    limited: true,
    notices: [{ name: "Named holder", ceased: true, pct: null }],
  });
  for (const r of [bad, absent])
    expect(r).toMatchObject({ asOf: null, notices: [] });
});

it("rejects malformed or oversized batches before making requests and handles empty lists", async () => {
  for (const batch of [
    ["ABC", "mismatch/issuer"],
    Array<string>(7).fill("RLC"),
    null,
  ]) {
    await expect(loadInvestorRegisters(batch as string[])).rejects.toThrow(
      /issuer batch/,
    );
  }
  await expect(loadInvestorRegisters([])).resolves.toEqual([]);
  expect(read).not.toHaveBeenCalled();
});

"use server";

import {
  REGISTER_BATCH,
  type InvestorRegister,
} from "~/@/lib/ownership/investor-activity";
import { disclosureRow } from "~/@/lib/ownership/investor-disclosures";
import { REGISTER_CODE_PATTERN } from "~/@/lib/ownership/kinds";
import { getStockOwnership } from "./getOwnership";

/** The browser sends issuer codes only. Identity matching and read state stay on the device. */
export async function loadInvestorRegisters(
  codes: string[],
): Promise<InvestorRegister[]> {
  if (
    !Array.isArray(codes) ||
    codes.length > REGISTER_BATCH ||
    !codes.every(
      (code: unknown) =>
        typeof code === "string" && REGISTER_CODE_PATTERN.test(code),
    )
  ) {
    throw new Error("Invalid issuer batch");
  }
  return Promise.all(
    [...new Set(codes)].map(async (code): Promise<InvestorRegister> => {
      const unavailable = { code, asOf: null, limited: false, notices: [] };
      try {
        const data = await getStockOwnership(code);
        if (!data?.asOf || data.summary?.stockCode !== code) return unavailable;
        return {
          code,
          asOf: data.asOf,
          limited: data.historyTotal > data.history.length,
          notices: data.history
            .filter(
              (n) =>
                n.stockCode === code &&
                ["603", "604", "605"].includes(n.form) &&
                !!n.holderName.trim(),
            )
            .map(disclosureRow),
        };
      } catch {
        return unavailable;
      }
    }),
  );
}

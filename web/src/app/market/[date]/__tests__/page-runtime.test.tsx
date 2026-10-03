/// <reference types="jest" />

import { describe, expect, it } from "@jest/globals";
import React from "react";
import { render, screen } from "@testing-library/react";
import { notFound } from "next/navigation";
import { getMarketByDate } from "~/app/actions/market/getMarketByDate";
import MarketDatePage, { generateMetadata } from "../page";

jest.mock("~/app/actions/market/getMarketByDate", () => ({ getMarketByDate: jest.fn() }));
jest.mock("~/@/components/layouts/dashboard-layout", () => ({ DashboardLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

const params = { params: Promise.resolve({ date: "2026-09-28" }) };
const snapshot = {
  totalCount: 120,
  stocks: [
    { productCode: "AAA", name: "ALPHA LIMITED ORDINARY", percentageShorted: 12, securityType: "ordinary", reportedShortPositions: "12000000" },
    { productCode: "JPGB", name: "JPM GLOBAL ACTIVE ETF UNITS", percentageShorted: 9, securityType: "etf", reportedShortPositions: "900000" },
    { productCode: "XVGHAF", name: "TREASURY CORPORATION 4.75%", percentageShorted: 6, securityType: "debt", reportedShortPositions: "600000" },
  ],
};

beforeEach(() => {
  jest.mocked(getMarketByDate).mockReset();
  jest.mocked(getMarketByDate).mockResolvedValue(snapshot as never);
  jest.mocked(notFound).mockReset();
  jest.mocked(notFound).mockImplementation(() => { throw new Error("NEXT_NOT_FOUND"); });
});

describe("Market Date Page Runtime", () => {
  it("renders market date pages dynamically because server RPC fetches are no-store POSTs", async () => {
    const PageModule = await import("../page");

    expect(PageModule.dynamic).toBe("force-dynamic");
    expect(PageModule.generateStaticParams).toBeUndefined();
  });
});

it("retains mixed instruments, labels count and displayed rows accurately, and explains the filtered list", async () => {
  render(await MarketDatePage(params));
  expect(screen.getByText("Securities with Short Positions")).toBeInTheDocument();
  expect(screen.getByText("Securities Displayed")).toBeInTheDocument();
  expect(screen.getByText("Of 120 reported securities")).toBeInTheDocument();
  expect(screen.getByText("Top 3 Shorted Securities")).toBeInTheDocument();
  expect(screen.getByText("Instrument type: ETF")).toBeInTheDocument();
  expect(screen.getByText("Instrument type: debt")).toBeInTheDocument();
  expect(screen.getByText("Alpha")).toBeInTheDocument();
  expect(screen.queryByText("Total Short Positions")).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "filtered top-shorts list" })).toHaveAttribute("href", "/top");
  expect(screen.getByRole("link", { name: "data methodology" })).toHaveAttribute("href", "/methodology");
  expect(getMarketByDate).toHaveBeenCalledWith("2026-09-28", 50, 0);
});

it("declares the dated canonical and securities/lag metadata", async () => {
  const metadata = await generateMetadata(params);
  expect(metadata.alternates?.canonical).toBe("https://shorted.com.au/market/2026-09-28");
  expect(metadata.description).toMatch(/securities.*ETFs and debt.*T\+4/);
});

it.each(["invalid", "2026-02-30", "2026-13-01"])("rejects invalid calendar date %s in metadata before a data read", async (date) => {
  await expect(generateMetadata({ params: Promise.resolve({ date }) })).rejects.toThrow("NEXT_NOT_FOUND");
  expect(getMarketByDate).not.toHaveBeenCalled();
});

it("returns notFound from metadata for dates with omitted proto repeated fields", async () => {
  jest.mocked(getMarketByDate).mockResolvedValue({ totalCount: 0 } as never);
  await expect(generateMetadata(params)).rejects.toThrow("NEXT_NOT_FOUND");
});

it("keeps an ambiguous failed read retryable instead of declaring a missing date", async () => {
  jest.mocked(getMarketByDate).mockResolvedValue(undefined);
  await expect(generateMetadata(params)).rejects.toThrow("temporarily unavailable");
  await expect(MarketDatePage(params)).rejects.toThrow("temporarily unavailable");
  expect(notFound).not.toHaveBeenCalled();
});

/// <reference types="jest" />
import React from "react";
import { render, screen } from "@testing-library/react";
import CompanyStats from "../companyStats";
import { getStock } from "~/app/actions/getStock";

jest.mock("~/app/actions/getStock", () => ({
  getStock: jest.fn(),
}));

jest.mock("~/@/lib/utils", () => ({
  cn: jest.fn((...classes: Array<string | undefined | false | null>) =>
    classes.filter(Boolean).join(" "),
  ),
  formatNumber: jest.fn((num: number, decimalPlaces = 1) => {
    if (num >= 1e9) {
      return `${(num / 1e9).toFixed(decimalPlaces).replace(/\.0$/, "")}B`;
    }
    if (num >= 1e6) {
      return `${(num / 1e6).toFixed(decimalPlaces).replace(/\.0$/, "")}M`;
    }
    if (num >= 1e3) {
      return `${(num / 1e3).toFixed(decimalPlaces).replace(/\.0$/, "")}K`;
    }
    return String(num);
  }),
}));

describe("CompanyStats", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders from initialStock without making a duplicate GetStock action call", async () => {
    const result = await CompanyStats({
      stockCode: "LOT",
      initialStock: {
        percentageShorted: 12.34,
        reportedShortPositions: 1234567,
        totalProductInIssue: 987654321,
      } as Parameters<typeof CompanyStats>[0]["initialStock"],
    });

    render(result);

    expect(getStock).not.toHaveBeenCalled();
    expect(screen.getByText("12.34%")).toBeInTheDocument();
    expect(screen.getByText("1.2M")).toBeInTheDocument();
  });

  it("renders the 'Short position' card title with all three stat labels", async () => {
    const result = await CompanyStats({
      stockCode: "LOT",
      initialStock: {
        percentageShorted: 12.34,
        reportedShortPositions: 1234567,
        totalProductInIssue: 987654321,
      } as Parameters<typeof CompanyStats>[0]["initialStock"],
    });

    render(result);

    expect(screen.getByText("Short position")).toBeInTheDocument();
    expect(screen.getByText("short percentage")).toBeInTheDocument();
    expect(screen.getByText("reported shorts")).toBeInTheDocument();
    expect(screen.getByText("shares on issue")).toBeInTheDocument();
  });
});

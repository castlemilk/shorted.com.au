"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CompanyTaxYear } from "~/gen/shorts/v1alpha1/shorts_pb";
import { getCompanyTaxProfileClient } from "~/app/actions/client/getCompanyTaxProfileClient";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/@/components/ui/table";
import { Badge } from "~/@/components/ui/badge";
import { Button } from "~/@/components/ui/button";
import { Landmark } from "lucide-react";

interface CompanyTaxCardProps {
  stockCode: string;
}

/**
 * Formats an A$ amount compactly ($X.XB / $X.XM / $Xk). Editorial standards
 * require total income + taxable income to render alongside tax payable — this is
 * a plain factual figure, no derived ratios or commentary.
 */
function formatAUD(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `$${(value / 1_000).toFixed(0)}k`;
  return `$${value.toFixed(0)}`;
}

/** ATO income year 2024 == financial year 2023–24. */
function financialYearLabel(incomeYear: number): string {
  return `${incomeYear - 1}–${String(incomeYear).slice(2)}`;
}

function TaxableCell({ year }: { year: CompanyTaxYear }) {
  if (!year.hasTaxableIncome) {
    return <span className="text-muted-foreground">—</span>;
  }
  return <span className="tabular-nums">{formatAUD(year.taxableIncome)}</span>;
}

function TaxPayableCell({ year }: { year: CompanyTaxYear }) {
  if (!year.hasTaxPayable) {
    return <span className="text-muted-foreground">not reported</span>;
  }

  // A reported zero is meaningful and often legitimate. Keep it distinct from
  // an absent ATO cell so the has_tax_payable contract remains visible.
  if (year.taxPayable === 0) {
    return (
      <Badge variant="secondary" className="font-normal">
        nil tax payable
      </Badge>
    );
  }
  return (
    <span className="tabular-nums font-medium">
      {formatAUD(year.taxPayable)}
    </span>
  );
}

const COLLAPSED_YEAR_COUNT = 5;

export function CompanyTaxCard({ stockCode }: CompanyTaxCardProps) {
  const [showAll, setShowAll] = useState(false);
  const { data, isLoading, isError } = useQuery({
    queryKey: ["company-tax", stockCode],
    queryFn: () => getCompanyTaxProfileClient(stockCode),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  // No ATO mapping for many stocks: render nothing while loading rather than
  // flashing a skeleton card that may unmount to null.
  if (isLoading) return null;

  // NotFound (no ATO mapping for this entity) or any other failure: render nothing.
  if (isError || !data || data.years.length === 0) return null;

  // Most recent year first; collapsed to the latest few by default.
  const allYears = [...data.years].sort((a, b) => b.incomeYear - a.incomeYear);
  const years = showAll ? allYears : allYears.slice(0, COLLAPSED_YEAR_COUNT);
  const hiddenYears = allYears.length - years.length;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg flex items-center gap-2">
          <Landmark className="h-5 w-5" />
          Tax paid
        </CardTitle>
        <CardDescription>
          Corporate income tax reported to the ATO
          {data.entityName ? ` for ${data.entityName}` : ""}
          {data.abn ? ` (ABN ${data.abn})` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {/* The shared Table already renders its own overflow-auto wrapper —
            no extra scroll container here. Taxable income is hidden below sm
            so Income year / Total income / Tax payable fit at 360px. */}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="px-2 sm:px-4">Income year</TableHead>
              <TableHead className="text-right px-2 sm:px-4">
                Total income
              </TableHead>
              <TableHead className="text-right px-2 sm:px-4 hidden sm:table-cell">
                Taxable income
              </TableHead>
              <TableHead className="text-right px-2 sm:px-4">
                Tax payable
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {years.map((year) => (
              <TableRow key={year.incomeYear}>
                <TableCell className="font-medium tabular-nums p-2 sm:p-4">
                  {financialYearLabel(year.incomeYear)}
                </TableCell>
                <TableCell className="text-right tabular-nums p-2 sm:p-4">
                  {formatAUD(year.totalIncome)}
                </TableCell>
                <TableCell className="text-right p-2 sm:p-4 hidden sm:table-cell">
                  <TaxableCell year={year} />
                </TableCell>
                <TableCell className="text-right p-2 sm:p-4">
                  <TaxPayableCell year={year} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        {hiddenYears > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="mt-2 w-full text-muted-foreground"
            onClick={() => setShowAll(true)}
          >
            Show {hiddenYears} earlier year{hiddenYears !== 1 ? "s" : ""}
          </Button>
        )}

        <div className="mt-3 space-y-1 text-xs text-muted-foreground">
          <p>
            Nil tax payable is often legitimate (losses, offsets); it does not
            imply avoidance.
          </p>
          <p>
            {data.sourceAttribution ||
              "ATO Corporate Tax Transparency (data.gov.au), CC BY 3.0 AU"}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

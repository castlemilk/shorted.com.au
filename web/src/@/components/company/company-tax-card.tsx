"use client";

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
import { Skeleton } from "~/@/components/ui/skeleton";
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
  // Nil / not-reported tax payable is meaningful and often legitimate — flag it
  // with a muted badge, but the income columns beside it always remain visible.
  if (!year.hasTaxPayable || year.taxPayable === 0) {
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

export function CompanyTaxCard({ stockCode }: CompanyTaxCardProps) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["company-tax", stockCode],
    queryFn: () => getCompanyTaxProfileClient(stockCode),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  if (isLoading) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg flex items-center gap-2">
            <Landmark className="h-5 w-5" />
            Tax paid
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-40 w-full" />
        </CardContent>
      </Card>
    );
  }

  // NotFound (no ATO mapping for this entity) or any other failure: render nothing.
  if (isError || !data || data.years.length === 0) return null;

  // Most recent year first.
  const years = [...data.years].sort((a, b) => b.incomeYear - a.incomeYear);

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
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Income year</TableHead>
                <TableHead className="text-right">Total income</TableHead>
                <TableHead className="text-right">Taxable income</TableHead>
                <TableHead className="text-right">Tax payable</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {years.map((year) => (
                <TableRow key={year.incomeYear}>
                  <TableCell className="font-medium tabular-nums">
                    {financialYearLabel(year.incomeYear)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatAUD(year.totalIncome)}
                  </TableCell>
                  <TableCell className="text-right">
                    <TaxableCell year={year} />
                  </TableCell>
                  <TableCell className="text-right">
                    <TaxPayableCell year={year} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

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

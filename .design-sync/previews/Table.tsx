import * as React from "react";
import {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
  Badge,
} from "shorted";

/** The canonical use: the ASIC top-shorts table — head, body, numeric columns right-aligned. */
export const TopShorts = () => (
  <Table>
    <TableHeader>
      <TableRow>
        <TableHead className="w-12">#</TableHead>
        <TableHead className="w-20">Code</TableHead>
        <TableHead>Company</TableHead>
        <TableHead className="text-right">Short %</TableHead>
        <TableHead className="text-right">1w change</TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      <TableRow>
        <TableCell className="text-muted-foreground">1</TableCell>
        <TableCell className="font-medium">PLS</TableCell>
        <TableCell>Pilbara Minerals</TableCell>
        <TableCell className="text-right tabular-nums">19.42%</TableCell>
        <TableCell className="text-right tabular-nums text-destructive">+0.38</TableCell>
      </TableRow>
      <TableRow>
        <TableCell className="text-muted-foreground">2</TableCell>
        <TableCell className="font-medium">LTR</TableCell>
        <TableCell>Liontown Resources</TableCell>
        <TableCell className="text-right tabular-nums">12.81%</TableCell>
        <TableCell className="text-right tabular-nums text-muted-foreground">−0.14</TableCell>
      </TableRow>
      <TableRow>
        <TableCell className="text-muted-foreground">3</TableCell>
        <TableCell className="font-medium">IEL</TableCell>
        <TableCell>IDP Education</TableCell>
        <TableCell className="text-right tabular-nums">11.06%</TableCell>
        <TableCell className="text-right tabular-nums text-destructive">+0.52</TableCell>
      </TableRow>
      <TableRow>
        <TableCell className="text-muted-foreground">4</TableCell>
        <TableCell className="font-medium">SLX</TableCell>
        <TableCell>Silex Systems</TableCell>
        <TableCell className="text-right tabular-nums">5.94%</TableCell>
        <TableCell className="text-right tabular-nums text-muted-foreground">−0.07</TableCell>
      </TableRow>
      <TableRow>
        <TableCell className="text-muted-foreground">5</TableCell>
        <TableCell className="font-medium">BHP</TableCell>
        <TableCell>BHP Group</TableCell>
        <TableCell className="text-right tabular-nums">0.81%</TableCell>
        <TableCell className="text-right tabular-nums text-muted-foreground">−0.02</TableCell>
      </TableRow>
    </TableBody>
    <TableCaption>ASIC short positions, reported 15 May 2024.</TableCaption>
  </Table>
);

/** TableFooter carries the aggregate row — muted background, medium weight. */
export const WithFooterTotals = () => (
  <Table>
    <TableHeader>
      <TableRow>
        <TableHead>Industry</TableHead>
        <TableHead className="text-right">Stocks</TableHead>
        <TableHead className="text-right">Avg short %</TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      <TableRow>
        <TableCell>Materials</TableCell>
        <TableCell className="text-right tabular-nums">312</TableCell>
        <TableCell className="text-right tabular-nums">2.14%</TableCell>
      </TableRow>
      <TableRow>
        <TableCell>Consumer Discretionary</TableCell>
        <TableCell className="text-right tabular-nums">148</TableCell>
        <TableCell className="text-right tabular-nums">1.87%</TableCell>
      </TableRow>
      <TableRow>
        <TableCell>Financials</TableCell>
        <TableCell className="text-right tabular-nums">203</TableCell>
        <TableCell className="text-right tabular-nums">0.63%</TableCell>
      </TableRow>
    </TableBody>
    <TableFooter>
      <TableRow>
        <TableCell>All industries</TableCell>
        <TableCell className="text-right tabular-nums">941</TableCell>
        <TableCell className="text-right tabular-nums">1.42%</TableCell>
      </TableRow>
    </TableFooter>
  </Table>
);

/** A selected row (`data-state="selected"`) beside plain rows, with inline Badge cells. */
export const SelectedRow = () => (
  <Table>
    <TableHeader>
      <TableRow>
        <TableHead className="w-20">Code</TableHead>
        <TableHead>Company</TableHead>
        <TableHead>Signal</TableHead>
        <TableHead className="text-right">Short %</TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      <TableRow>
        <TableCell className="font-medium">BOE</TableCell>
        <TableCell>Boss Energy</TableCell>
        <TableCell>
          <Badge variant="secondary">Crowded</Badge>
        </TableCell>
        <TableCell className="text-right tabular-nums">9.63%</TableCell>
      </TableRow>
      <TableRow data-state="selected">
        <TableCell className="font-medium">SYA</TableCell>
        <TableCell>Sayona Mining</TableCell>
        <TableCell>
          <Badge variant="destructive">Squeeze risk</Badge>
        </TableCell>
        <TableCell className="text-right tabular-nums">8.12%</TableCell>
      </TableRow>
      <TableRow>
        <TableCell className="font-medium">CSL</TableCell>
        <TableCell>CSL Limited</TableCell>
        <TableCell>
          <Badge variant="outline">Stable</Badge>
        </TableCell>
        <TableCell className="text-right tabular-nums">0.44%</TableCell>
      </TableRow>
    </TableBody>
  </Table>
);

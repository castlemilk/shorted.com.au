import * as React from "react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  Badge,
} from "shorted";

/**
 * The canonical form: `type="single"` + `collapsible`, with `defaultValue`
 * holding the first panel open so the expanded state renders statically.
 */
export const Default = () => (
  <Accordion type="single" collapsible defaultValue="reporting" className="w-96">
    <AccordionItem value="reporting">
      <AccordionTrigger>How often is short data reported?</AccordionTrigger>
      <AccordionContent className="text-muted-foreground">
        ASIC publishes aggregated short positions each trading day, with a
        four-business-day lag. Shorted ingests the file at 2am AEST.
      </AccordionContent>
    </AccordionItem>
    <AccordionItem value="percent">
      <AccordionTrigger>What does percent shorted mean?</AccordionTrigger>
      <AccordionContent className="text-muted-foreground">
        Reported short positions divided by total product in issue.
      </AccordionContent>
    </AccordionItem>
    <AccordionItem value="coverage">
      <AccordionTrigger>Which securities are covered?</AccordionTrigger>
      <AccordionContent className="text-muted-foreground">
        Every ASX-listed product ASIC reports on: roughly 2,400 codes.
      </AccordionContent>
    </AccordionItem>
  </Accordion>
);

/** All panels closed — the resting state of a long FAQ list. */
export const Collapsed = () => (
  <Accordion type="single" collapsible className="w-96">
    <AccordionItem value="materials">
      <AccordionTrigger>Materials</AccordionTrigger>
      <AccordionContent>Pilbara Minerals, BHP Group, Rio Tinto</AccordionContent>
    </AccordionItem>
    <AccordionItem value="financials">
      <AccordionTrigger>Financials</AccordionTrigger>
      <AccordionContent>Commonwealth Bank, Westpac, ANZ Group</AccordionContent>
    </AccordionItem>
    <AccordionItem value="energy">
      <AccordionTrigger>Energy</AccordionTrigger>
      <AccordionContent>Woodside Energy, Santos, Whitehaven Coal</AccordionContent>
    </AccordionItem>
  </Accordion>
);

/** `type="multiple"` — more than one panel open at a time. */
export const Multiple = () => (
  <Accordion
    type="multiple"
    defaultValue={["pls", "cba"]}
    className="w-96"
  >
    <AccordionItem value="pls">
      <AccordionTrigger>PLS · Pilbara Minerals</AccordionTrigger>
      <AccordionContent className="text-muted-foreground">
        19.4% of shares on issue held short, the most shorted stock on the ASX.
      </AccordionContent>
    </AccordionItem>
    <AccordionItem value="cba">
      <AccordionTrigger>CBA · Commonwealth Bank</AccordionTrigger>
      <AccordionContent className="text-muted-foreground">
        0.9% short, flat against the Financials median over 3 months.
      </AccordionContent>
    </AccordionItem>
  </Accordion>
);

/** A trigger carrying trailing metadata — the pattern used on sector lists. */
export const WithBadge = () => (
  <Accordion type="single" collapsible defaultValue="lithium" className="w-96">
    <AccordionItem value="lithium">
      <AccordionTrigger>
        <span className="flex flex-1 items-center justify-between pr-3">
          Lithium
          <Badge variant="secondary">12 stocks</Badge>
        </span>
      </AccordionTrigger>
      <AccordionContent className="text-muted-foreground">
        Median short interest 8.1%, up 2.3 points over 6 months.
      </AccordionContent>
    </AccordionItem>
    <AccordionItem value="iron-ore">
      <AccordionTrigger>
        <span className="flex flex-1 items-center justify-between pr-3">
          Iron Ore
          <Badge variant="secondary">9 stocks</Badge>
        </span>
      </AccordionTrigger>
      <AccordionContent className="text-muted-foreground">
        Median short interest 1.4%, down 0.2 points over 6 months.
      </AccordionContent>
    </AccordionItem>
  </Accordion>
);

import * as React from "react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
  Label,
} from "shorted";

const PERIODS = (
  <SelectContent>
    <SelectItem value="1m">1 month</SelectItem>
    <SelectItem value="3m">3 months</SelectItem>
    <SelectItem value="6m">6 months</SelectItem>
    <SelectItem value="1y">1 year</SelectItem>
    <SelectItem value="2y">2 years</SelectItem>
  </SelectContent>
);

/** Closed trigger with a placeholder — the resting state of every filter select. */
export const Default = () => (
  <Select>
    <SelectTrigger className="w-56">
      <SelectValue placeholder="Select a period" />
    </SelectTrigger>
    {PERIODS}
  </Select>
);

/** Closed trigger carrying a selected value (`defaultValue`). */
export const WithValue = () => (
  <Select defaultValue="6m">
    <SelectTrigger className="w-56">
      <SelectValue placeholder="Select a period" />
    </SelectTrigger>
    {PERIODS}
  </Select>
);

/** The idiomatic field: Label above a Select, as used on the screener. */
export const WithLabel = () => (
  <div className="grid w-56 gap-2">
    <Label htmlFor="sector">Sector</Label>
    <Select defaultValue="materials">
      <SelectTrigger id="sector">
        <SelectValue placeholder="All sectors" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="materials">Materials</SelectItem>
        <SelectItem value="financials">Financials</SelectItem>
        <SelectItem value="energy">Energy</SelectItem>
        <SelectItem value="health-care">Health Care</SelectItem>
      </SelectContent>
    </Select>
  </div>
);

/**
 * Open list with a group label, checked indicator and separator. Radix portals
 * the list, so the root is held `open` to render it statically.
 */
export const OpenList = () => (
  <div className="h-64 w-56">
    <Select open defaultValue="pls">
      <SelectTrigger className="w-56">
        <SelectValue placeholder="Select a stock" />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectLabel>Materials</SelectLabel>
          <SelectItem value="pls">PLS · Pilbara Minerals</SelectItem>
          <SelectItem value="bhp">BHP · BHP Group</SelectItem>
          <SelectItem value="rio">RIO · Rio Tinto</SelectItem>
        </SelectGroup>
        <SelectSeparator />
        <SelectGroup>
          <SelectLabel>Financials</SelectLabel>
          <SelectItem value="cba">CBA · Commonwealth Bank</SelectItem>
          <SelectItem value="anz">ANZ · ANZ Group</SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  </div>
);

/** Disabled trigger — filters that are unavailable until data loads. */
export const Disabled = () => (
  <Select disabled defaultValue="asic">
    <SelectTrigger className="w-56">
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      <SelectItem value="asic">ASIC daily report</SelectItem>
    </SelectContent>
  </Select>
);

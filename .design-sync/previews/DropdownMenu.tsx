import * as React from "react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuGroup,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  Button,
} from "shorted";

/**
 * The canonical row-actions menu. Held `open` so the portalled panel renders —
 * a closed DropdownMenu paints nothing at all.
 */
export const Default = () => (
  <div className="flex justify-center pb-24 pt-2">
    <DropdownMenu open modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant="outline">PLS actions</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel>Pilbara Minerals</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem>
            Open stock page
            <DropdownMenuShortcut>⏎</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem>
            Add to watchlist
            <DropdownMenuShortcut>⌘W</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem>
            Export CSV
            <DropdownMenuShortcut>⌘E</DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled>Compare to peers</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </div>
);

/** Checkbox items — the column-visibility menu on the top-shorts table. */
export const CheckboxItems = () => (
  <div className="flex justify-center pb-24 pt-2">
    <DropdownMenu open modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant="outline">Columns</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel>Visible columns</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem checked>Short %</DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem checked>1w change</DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem checked={false}>Days to cover</DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem checked={false}>Market cap</DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </div>
);

/** Radio items — one-of-many selection, here the reporting period. */
export const RadioItems = () => (
  <div className="flex justify-center pb-24 pt-2">
    <DropdownMenu open modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant="outline">Period: 6 months</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel>Reporting period</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value="6m">
          <DropdownMenuRadioItem value="3m">3 months</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="6m">6 months</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="1y">1 year</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="max">All history</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  </div>
);

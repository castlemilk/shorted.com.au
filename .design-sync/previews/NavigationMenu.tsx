import * as React from "react";
import {
  NavigationMenu,
  NavigationMenuList,
  NavigationMenuItem,
  NavigationMenuTrigger,
  NavigationMenuContent,
  NavigationMenuLink,
  navigationMenuTriggerStyle,
} from "shorted";

/**
 * The site nav with one panel open. `defaultValue` must match an item's
 * `value` or the viewport stays empty — a closed NavigationMenu shows triggers only.
 */
export const Default = () => (
  <div className="pb-24 pt-2">
    <NavigationMenu defaultValue="markets">
      <NavigationMenuList>
        <NavigationMenuItem value="markets">
          <NavigationMenuTrigger>Markets</NavigationMenuTrigger>
          <NavigationMenuContent>
            <ul className="grid w-[400px] gap-2 p-4 md:grid-cols-2">
              <li>
                <NavigationMenuLink
                  href="/top"
                  className="block select-none rounded-md p-3 hover:bg-accent hover:text-accent-foreground"
                >
                  <div className="text-sm font-medium">Top shorts</div>
                  <p className="text-xs text-muted-foreground">
                    The 50 most shorted ASX securities, daily from ASIC.
                  </p>
                </NavigationMenuLink>
              </li>
              <li>
                <NavigationMenuLink
                  href="/screener"
                  className="block select-none rounded-md p-3 hover:bg-accent hover:text-accent-foreground"
                >
                  <div className="text-sm font-medium">Screener</div>
                  <p className="text-xs text-muted-foreground">
                    Filter by short interest, industry and days to cover.
                  </p>
                </NavigationMenuLink>
              </li>
              <li>
                <NavigationMenuLink
                  href="/reports"
                  className="block select-none rounded-md p-3 hover:bg-accent hover:text-accent-foreground"
                >
                  <div className="text-sm font-medium">Weekly reports</div>
                  <p className="text-xs text-muted-foreground">
                    Movers, streaks and industry breakdowns, every Friday.
                  </p>
                </NavigationMenuLink>
              </li>
              <li>
                <NavigationMenuLink
                  href="/economy"
                  className="block select-none rounded-md p-3 hover:bg-accent hover:text-accent-foreground"
                >
                  <div className="text-sm font-medium">Economy</div>
                  <p className="text-xs text-muted-foreground">
                    ABS and RBA series, mapped by state.
                  </p>
                </NavigationMenuLink>
              </li>
            </ul>
          </NavigationMenuContent>
        </NavigationMenuItem>
        <NavigationMenuItem value="housing">
          <NavigationMenuTrigger>Housing</NavigationMenuTrigger>
          <NavigationMenuContent>
            <div className="w-[300px] p-4 text-sm">Suburb explorer and price drops.</div>
          </NavigationMenuContent>
        </NavigationMenuItem>
        <NavigationMenuItem>
          <NavigationMenuLink href="/docs/api" className={navigationMenuTriggerStyle()}>
            API
          </NavigationMenuLink>
        </NavigationMenuItem>
      </NavigationMenuList>
    </NavigationMenu>
  </div>
);

/** The resting bar: plain links styled with `navigationMenuTriggerStyle()`, no panel open. */
export const LinksOnly = () => (
  <div className="pt-2">
    <NavigationMenu>
      <NavigationMenuList>
        <NavigationMenuItem>
          <NavigationMenuLink href="/top" className={navigationMenuTriggerStyle()}>
            Top shorts
          </NavigationMenuLink>
        </NavigationMenuItem>
        <NavigationMenuItem>
          <NavigationMenuLink href="/screener" className={navigationMenuTriggerStyle()}>
            Screener
          </NavigationMenuLink>
        </NavigationMenuItem>
        <NavigationMenuItem>
          <NavigationMenuLink href="/reports" className={navigationMenuTriggerStyle()}>
            Reports
          </NavigationMenuLink>
        </NavigationMenuItem>
        <NavigationMenuItem>
          <NavigationMenuLink href="/pricing" className={navigationMenuTriggerStyle()}>
            Pricing
          </NavigationMenuLink>
        </NavigationMenuItem>
      </NavigationMenuList>
    </NavigationMenu>
  </div>
);

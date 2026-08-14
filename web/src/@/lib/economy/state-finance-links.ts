import type { StateSlug } from "./map-metrics";

export interface StateFinanceLink {
  label: string;
  href: string;
}

const ABS_GFS_RELEASE: StateFinanceLink = {
  label: "ABS Government Finance Statistics",
  href: "https://www.abs.gov.au/statistics/economy/government/government-finance-statistics-australia/latest-release",
};

/**
 * Durable official landing pages rather than release-specific PDF URLs.
 * Each entry was hand-curated from the established government hostnames.
 */
export const STATE_FINANCE_LINKS = {
  // lastVerified: 2026-07-22
  nsw: [
    { label: "NSW Budget papers", href: "https://www.budget.nsw.gov.au/" },
    { label: "NSW Treasury", href: "https://www.treasury.nsw.gov.au/" },
    ABS_GFS_RELEASE,
  ],
  // lastVerified: 2026-07-22
  vic: [
    { label: "Victorian Budget papers", href: "https://www.budget.vic.gov.au/" },
    { label: "Victorian Department of Treasury and Finance", href: "https://www.dtf.vic.gov.au/" },
    ABS_GFS_RELEASE,
  ],
  // lastVerified: 2026-07-22
  qld: [
    { label: "Queensland Budget papers", href: "https://budget.qld.gov.au/" },
    { label: "Queensland Treasury", href: "https://www.treasury.qld.gov.au/" },
    ABS_GFS_RELEASE,
  ],
  // lastVerified: 2026-07-22
  sa: [
    { label: "South Australian Budget papers", href: "https://www.statebudget.sa.gov.au/" },
    { label: "South Australian Department of Treasury and Finance", href: "https://www.treasury.sa.gov.au/" },
    ABS_GFS_RELEASE,
  ],
  // lastVerified: 2026-07-22
  wa: [
    { label: "Western Australian Budget papers", href: "https://www.ourstatebudget.wa.gov.au/" },
    { label: "Western Australian Department of Treasury", href: "https://www.wa.gov.au/organisation/department-of-treasury" },
    ABS_GFS_RELEASE,
  ],
  // lastVerified: 2026-07-22
  tas: [
    { label: "Tasmanian Budget papers", href: "https://www.budget.tas.gov.au/" },
    { label: "Tasmanian Department of Treasury and Finance", href: "https://www.treasury.tas.gov.au/" },
    ABS_GFS_RELEASE,
  ],
  // lastVerified: 2026-07-22
  nt: [
    { label: "Northern Territory Budget papers", href: "https://budget.nt.gov.au/" },
    { label: "Northern Territory Treasury", href: "https://treasury.nt.gov.au/" },
    ABS_GFS_RELEASE,
  ],
  // lastVerified: 2026-07-22
  act: [
    { label: "ACT Budget papers", href: "https://www.act.gov.au/budget" },
    { label: "ACT Treasury", href: "https://www.treasury.act.gov.au/" },
    ABS_GFS_RELEASE,
  ],
} satisfies Record<StateSlug, readonly StateFinanceLink[]>;

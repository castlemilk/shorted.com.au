import { ImageResponse } from "next/og";
import { OgCard, OG_SIZE, getOgLogo } from "~/@/lib/og/card";
import {
  annualInterestsForInvestor,
  investorCodes,
  investorPct,
  ranksForInvestor,
  type AustralianInvestor,
} from "~/@/lib/ownership/australian-investors";
import type { TraderProfile } from "~/@/lib/ownership/traders";
import { getSecHoldings } from "./get-sec-holdings";
import { displayRecordDate, professionalRecord } from "./profile-metadata";

export async function investorShareCard(
  person: AustralianInvestor | TraderProfile,
) {
  const logoSrc = await getOgLogo();
  const record = professionalRecord(person);
  const subtitle = record
    ? `${record.role} · ${record.organization}`
    : "description" in person
      ? person.description
      : person.firm;
  let footer = record?.sourceLabel ?? "ASX shareholder disclosures";
  let eyebrow = "Australian investor";
  let stats: { label: string; value: string }[] = [];

  if ("reporting" in person) {
    if (person.reporting.market === "US") {
      eyebrow = "SEC holdings report";
      const data = await getSecHoldings(person.reporting.cik);
      const latest = data.periods[0];
      const report = latest?.snapshot;
      if (latest) {
        footer = `SEC · quarter ended ${displayRecordDate(latest.filings[0]!.period)}`;
        if (report)
          stats = [
            {
              label: "value on filing cover",
              value: `US$${report.totalUsd.toLocaleString("en-AU")}`,
            },
            { label: "entries filed", value: String(report.positions.length) },
          ];
      }
    } else {
      eyebrow = "ASX reporting manager";
      stats = [
        {
          label: person.milestone.label,
          value: displayRecordDate(person.milestone.date),
        },
      ];
    }
  } else {
    const ranks = ranksForInvestor(person.slug);
    const first = ranks[0];
    // Show rank and percentage only when a single printed account supports them.
    const interest = annualInterestsForInvestor(person)[0];
    if (interest && (!first || interest.date >= first.date)) {
      eyebrow = "Reported substantial interest";
      footer = `${interest.code} · ${displayRecordDate(interest.date)} · annual report p. ${interest.page}`;
      if (interest.amount.shares !== undefined)
        stats.push({
          label: "ordinary shares reported",
          value: interest.amount.shares.toLocaleString("en-AU"),
        });
      if (interest.amount.pct !== undefined)
        stats.push({
          label: "reported interest",
          value: investorPct(interest.amount.pct),
        });
    } else if (first && ranks.every((r) => r.source === first.source)) {
      eyebrow = "ASX shareholder register";
      footer = `${first.code} · ${first.dateBasis ? "FY ended " : ""}${displayRecordDate(first.date)} · annual report p. ${first.page}`;
      stats =
        ranks.length === 1
          ? [
              {
                label: first.orderedListSize
                  ? "register position"
                  : "printed rank",
                value: `#${first.rank} of ${first.orderedListSize ?? 20}`,
              },
              {
                label: `share of ${first.code}`,
                value: investorPct(first.pct),
              },
            ]
          : [
              { label: "registered accounts", value: String(ranks.length) },
              {
                label: first.orderedListSize
                  ? "register positions"
                  : "printed ranks",
                value: ranks.map((r) => r.rank).join(", "),
              },
            ];
    } else if (person.filings[0]?.notice) {
      const { code, notice } = person.filings[0];
      eyebrow = "ASX substantial holder notice";
      footer = `${code} · Form ${notice.form} · filed ${displayRecordDate(notice.date)}`;
      stats =
        notice.form === "605"
          ? [{ label: "filing status", value: "Ceased" }]
          : [
              {
                label: "voting power at filing",
                value: investorPct(notice.pct),
              },
            ];
    } else {
      stats = [
        { label: "issuer registers", value: investorCodes(person).join(" · ") },
      ];
      footer = "Named ASX shareholder disclosures";
    }
  }
  return new ImageResponse(
    (
      <OgCard
        logoSrc={logoSrc}
        title={person.name}
        eyebrow={eyebrow}
        subtitle={subtitle}
        stats={stats}
        footer={footer}
      />
    ),
    OG_SIZE,
  );
}

/// <reference types="jest" />

import { render, screen } from "@testing-library/react";
import { UrlTabsView } from "../url-tabs";

const TABS = [
  { id: "funds" as const, label: "Fund snapshots", panel: <p>Funds panel</p> },
  { id: "notices" as const, label: "Substantial notices", panel: <p>Notices panel</p> },
];

function renderTabs(search: string) {
  render(
    <UrlTabsView
      label="Changes"
      tabs={TABS}
      defaultTab="funds"
      inferFrom={{ tab: "notices", when: ["window", "event"] }}
      params={new URLSearchParams(search)}
      pathname="/ownership/changes"
      navigate={jest.fn()}
    />,
  );
}

describe("the URL tabs' inference (spec 14.3, Changes)", () => {
  it("opens the notices tab when a notice-feed parameter names no tab", () => {
    renderTabs("event=new");
    expect(screen.getByRole("tab", { name: "Substantial notices" })).toHaveAttribute("aria-selected", "true");
  });

  it("keeps an explicit tab over the inference", () => {
    renderTabs("tab=funds&event=new");
    expect(screen.getByRole("tab", { name: "Fund snapshots" })).toHaveAttribute("aria-selected", "true");
  });

  it("falls back to the default tab when nothing names one", () => {
    renderTabs("");
    expect(screen.getByRole("tab", { name: "Fund snapshots" })).toHaveAttribute("aria-selected", "true");
  });
});

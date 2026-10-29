import { render, screen, within } from "@testing-library/react";

import { COMMANDS } from "~/@/lib/discord/commands";

jest.mock("@/lib/utils", () => jest.requireActual("@/lib/utils"));

const APP_ID = "1290000000000000000";

function renderPage(app: { applicationId: string; activity: boolean }) {
  jest.isolateModules(() => {
    jest.doMock("~/config/discord-app.json", () => ({
      publicKey: "",
      ...app,
    }));
    const { default: Page } =
      jest.requireActual<typeof import("../page")>("../page");
    render(<Page />);
  });
}

describe("/docs/discord", () => {
  it("says the app is being set up until one is committed", () => {
    renderPage({ applicationId: "", activity: false });
    expect(screen.getByText(/being set up/i)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Add to a server" })).toBeNull();
    expect(screen.queryByText("Interactive")).toBeNull();
  });

  it("links to both installs of the committed app", () => {
    renderPage({ applicationId: APP_ID, activity: true });
    const server = screen.getByRole("link", { name: "Add to a server" });
    const user = screen.getByRole("link", { name: "Add to my apps" });
    expect(server.getAttribute("href")).toContain(`client_id=${APP_ID}`);
    expect(server.getAttribute("href")).toContain("integration_type=0");
    expect(user.getAttribute("href")).toContain("integration_type=1");
    expect(screen.getByText("Interactive")).toBeInTheDocument();
  });

  it("explains settings at the anchor the settings page links to", () => {
    renderPage({ applicationId: APP_ID, activity: true });
    const heading = screen.getByRole("heading", { name: "Settings" });
    expect(heading).toHaveAttribute("id", "settings");
    expect(screen.getByText(/for:Just me/)).toBeInTheDocument();
  });

  it("lists every command the bot registers, with its options", () => {
    renderPage({ applicationId: "", activity: false });
    const table = screen.getByRole("table");
    for (const command of COMMANDS) {
      expect(
        within(table).getByText(new RegExp(`^/${command.name}( |$)`)),
      ).toBeInTheDocument();
    }
    expect(
      within(table).getByText("/chart [code] [view] [period]"),
    ).toBeInTheDocument();
  });
});

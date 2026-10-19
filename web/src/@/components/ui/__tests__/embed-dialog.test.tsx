import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { EmbedDialog } from "../embed-dialog";

// The dialog body is behind next/dynamic to keep Radix out of the first-load
// bundle (see embed-dialog.tsx). Resolve it synchronously here so the test
// exercises the real content component rather than a loading placeholder.
jest.mock("next/dynamic", () => (loader: () => Promise<unknown>) => {
  const Lazy = React.lazy(async () => {
    const mod = (await loader()) as React.ComponentType<unknown>;
    return { default: mod };
  });
  const Wrapped = (props: Record<string, unknown>) => (
    <React.Suspense fallback={null}>
      <Lazy {...props} />
    </React.Suspense>
  );
  Wrapped.displayName = "DynamicMock";
  return Wrapped;
});

const TRIGGER = "Share or embed this chart";

beforeEach(() => {
  window.localStorage.clear();
});

async function openDialog(
  target: React.ComponentProps<typeof EmbedDialog>["target"],
  trigger = TRIGGER,
) {
  const user = userEvent.setup();
  render(<EmbedDialog target={target} />);
  await user.click(screen.getByTitle(trigger));
  const dialog = await screen.findByRole("dialog");
  // The body is a lazy chunk: wait for its tabs.
  await screen.findByRole("tab", { name: /Discord/ });
  return { user, dialog };
}

describe("EmbedDialog", () => {
  it("does not mount the dialog body until the trigger is clicked", () => {
    render(<EmbedDialog target={{ kind: "chart", code: "BHP" }} />);
    expect(screen.getByTitle(TRIGGER)).toBeInTheDocument();
    // Nothing from the heavy half is present up-front.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("leads with a share link and Discord copy, not HTML (the reported paste)", async () => {
    const { dialog } = await openDialog({
      kind: "chart",
      code: "WBT",
      view: "combined",
      period: "1m",
    });

    expect(screen.getByLabelText("Link")).toHaveValue(
      "https://shorted.com.au/chart/WBT?view=combined&period=1m",
    );
    expect(screen.getByRole("tab", { name: /Discord/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(dialog.textContent).toContain(
      "**WBT share price and short interest, past month**",
    );
    expect(dialog.textContent).not.toContain("<iframe");
  });

  it("offers the website snippet, with both crawlable links, on its own tab", async () => {
    const { user, dialog } = await openDialog({ kind: "chart", code: "BHP" });

    await user.click(screen.getByRole("tab", { name: /Website/ }));

    await waitFor(() => {
      expect(dialog.textContent).toContain(
        'href="https://shorted.com.au/shorts/BHP">BHP short interest',
      );
    });
    expect(dialog.textContent).toContain(
      'href="https://shorted.com.au">Shorted.com.au',
    );
    expect(dialog.textContent).toContain('loading="lazy"');
  });

  it("labels each widget kind correctly", async () => {
    const { user, dialog } = await openDialog(
      { kind: "top-shorts", limit: 20 },
      "Share or embed this table",
    );

    expect(screen.getByLabelText("Link")).toHaveValue(
      "https://shorted.com.au/top",
    );
    await user.click(screen.getByRole("tab", { name: /Website/ }));
    await waitFor(() => {
      expect(dialog.textContent).toContain(
        "https://shorted.com.au/embed/top-shorts?limit=20",
      );
    });
    expect(dialog.textContent).toContain("most shorted ASX stocks");
  });

  it("embeds the view and period the reader was looking at", async () => {
    const { user, dialog } = await openDialog({
      kind: "chart",
      code: "BHP",
      view: "combined",
      period: "6m",
    });

    await user.click(screen.getByRole("tab", { name: /Website/ }));
    await waitFor(() => {
      expect(dialog.textContent).toContain(
        "https://shorted.com.au/embed/chart?code=BHP&view=combined&period=6m",
      );
    });
    expect(dialog.textContent).toContain('height="520"');
    expect(dialog.textContent).toContain(
      'href="https://shorted.com.au/shorts/BHP">BHP share price and short interest',
    );
  });

  it("opens X's own composer, prefilled", async () => {
    const { user } = await openDialog({ kind: "chart", code: "BHP" });

    await user.click(screen.getByRole("tab", { name: /^X$/ }));

    const post = await screen.findByRole("link", { name: /Post on X/ });
    expect(post.getAttribute("href")).toMatch(
      /^https:\/\/x\.com\/intent\/tweet\?/,
    );
    expect(post).toHaveAttribute("target", "_blank");
    expect(post.getAttribute("rel")).toContain("noopener");
  });

  it("previews the chart's card, from this origin", async () => {
    await openDialog({ kind: "chart", code: "WBT", view: "price", period: "3m" });

    expect(screen.getByRole("img", { name: /^Preview:/ })).toHaveAttribute(
      "src",
      "/chart/WBT/image?view=price&period=3m",
    );
    expect(
      screen.getByRole("link", { name: /Download image/ }),
    ).toHaveAttribute("download", "WBT-price-3m.png");
  });

  it("focuses Copy link on open, not the link field (no selection menu on a phone)", async () => {
    await openDialog({ kind: "chart", code: "BHP" });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Copy link" })).toHaveFocus();
    });
  });

  it("remembers the channel a visitor last used", async () => {
    const first = await openDialog({ kind: "chart", code: "BHP" });
    await first.user.click(screen.getByRole("tab", { name: /Slack/ }));
    expect(window.localStorage.getItem("shorted:share-channel")).toBe("slack");
    cleanup();

    await openDialog({ kind: "chart", code: "CBA" });
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /Slack/ })).toHaveAttribute(
        "aria-selected",
        "true",
      );
    });
  });
});

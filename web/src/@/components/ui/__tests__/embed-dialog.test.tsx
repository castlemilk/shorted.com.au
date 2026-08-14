import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
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

describe("EmbedDialog", () => {
  it("does not mount the dialog body until the trigger is clicked", () => {
    render(<EmbedDialog target={{ kind: "chart", code: "BHP" }} />);
    expect(screen.getByTitle("Embed this chart on your site")).toBeInTheDocument();
    // Nothing from the heavy half is present up-front.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens on click and shows a snippet with both crawlable links", async () => {
    const user = userEvent.setup();
    render(<EmbedDialog target={{ kind: "chart", code: "BHP" }} />);

    await user.click(screen.getByTitle("Embed this chart on your site"));

    const dialog = await screen.findByRole("dialog");
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
    const user = userEvent.setup();
    render(<EmbedDialog target={{ kind: "top-shorts", limit: 20 }} />);

    await user.click(screen.getByTitle("Embed this table on your site"));

    const dialog = await screen.findByRole("dialog");
    await waitFor(() => {
      expect(dialog.textContent).toContain("most shorted ASX stocks");
    });
    expect(dialog.textContent).toContain(
      "https://shorted.com.au/embed/top-shorts?limit=20",
    );
  });
});

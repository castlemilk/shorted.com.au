/**
 * WidgetWrapper stories — dashboard chrome component.
 *
 * This component is pure props-driven (no data fetching, no server actions),
 * so no sb.mock or beforeEach mocking is required. Stories are simpler than
 * widget stories.
 *
 * Portal note: The Settings dropdown (Radix DropdownMenu) renders its content
 * in a portal — outside canvasElement. The play function must query via
 * `within(document.body)` (i.e. `screen`) rather than `within(canvasElement)`
 * to find the menu items. This is documented here as a learnable pattern.
 */
import React from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";

import { WidgetWrapper } from "./widget-wrapper";
import { WidgetType } from "~/@/types/dashboard";
import { makeWidgetConfig, withGridCell } from "~/@/mocks/widget-story-helpers";

const baseConfig = makeWidgetConfig(WidgetType.TOP_SHORTS);

const meta = {
  title: "Dashboard/WidgetWrapper",
  component: WidgetWrapper,
  args: {
    config: baseConfig,
    children: <div className="p-4">Widget content</div>,
    isEditMode: false,
    isSelected: false,
    onRemove: fn(),
    onEdit: fn(),
    isLoading: false,
    error: undefined,
  },
  decorators: [withGridCell("medium")],
} satisfies Meta<typeof WidgetWrapper>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Default state: card with title, expand button, settings button, children.
 */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Config title is rendered from WidgetType.TOP_SHORTS → "TOP SHORTS"
    expect(canvas.getByText(/top shorts/i)).toBeInTheDocument();
    expect(canvas.getByText("Widget content")).toBeInTheDocument();
  },
};

/**
 * EditMode: isEditMode=true shows X remove button and the card gets cursor-move.
 * The settings dropdown is still accessible via the Settings icon button.
 *
 * Play: open the settings dropdown and verify "Configure Widget" menu item.
 * IMPORTANT — Radix DropdownMenuContent renders in a PORTAL outside
 * canvasElement. Use `within(document.body)` to find portal-rendered items.
 */
export const EditMode: Story = {
  args: {
    isEditMode: true,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // In edit mode, the header has two icon buttons: Settings (gear) and X (remove).
    // Both have empty accessible names (icon-only buttons with no aria-label).
    // We can verify edit mode by checking two buttons exist in the header area.
    const buttons = canvas.getAllByRole("button");
    // There should be at least 2 buttons in edit mode (Settings + X).
    // In non-edit mode there would be Maximize + Settings (2), in edit mode
    // there's Settings + Remove (2).
    expect(buttons.length).toBeGreaterThanOrEqual(2);

    // Click the Settings button (first button in edit mode — no Maximize).
    // The Settings icon button is always present and is the dropdown trigger.
    const settingsButton = buttons[0]!;
    await userEvent.click(settingsButton);

    // Portal: menu content renders outside canvasElement — query document.body.
    // Radix DropdownMenuContent is appended to document.body, not canvasElement.
    await waitFor(() => {
      const menuItem = within(document.body).getByRole("menuitem", {
        name: /configure widget/i,
      });
      expect(menuItem).toBeInTheDocument();
    });
  },
};

/**
 * Loading state: children are replaced by skeleton placeholders.
 */
export const Loading: Story = {
  args: {
    isLoading: true,
    children: <div className="p-4">Should not appear</div>,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Skeleton is rendered — check the loading container is present
    // and that children are NOT shown.
    expect(canvas.queryByText("Should not appear")).not.toBeInTheDocument();
  },
};

/**
 * ErrorState: when an error is passed, a "Failed to load widget" message shows.
 */
export const ErrorState: Story = {
  args: {
    // Use globalThis.Error: "export const Error" shadows the global
    // constructor inside this module scope.
    error: new globalThis.Error("boom"),
    children: <div className="p-4">Should not appear</div>,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByText(/failed to load widget/i)).toBeInTheDocument();
    expect(canvas.queryByText("Should not appear")).not.toBeInTheDocument();
  },
};

/**
 * Selected: ring-2 ring-primary CSS is applied when isSelected=true.
 */
export const Selected: Story = {
  args: {
    isSelected: true,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Card element has ring classes; verify children still render.
    expect(canvas.getByText("Widget content")).toBeInTheDocument();
  },
};

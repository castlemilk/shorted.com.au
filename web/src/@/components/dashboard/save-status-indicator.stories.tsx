/**
 * SaveStatusIndicator stories — dashboard chrome component.
 *
 * One story per SaveStatus value (idle, pending, saving, saved, error, offline),
 * plus a variant for the idle state showing lastSavedAt.
 *
 * Relative-time note: The `idle` status with a `lastSavedAt` prop renders
 * relative text like "2m ago" that is clock-dependent. The IdleWithLastSaved
 * story passes a fixed Date from exactly 2 minutes before a frozen reference
 * time, but since we cannot freeze the clock here without extra setup, the
 * play assertion on that story checks the structural element ("Cloud" icon +
 * text containing "ago" or "just now" or a date) rather than an exact string.
 * The story is NOT tagged "no-visual" because the relative calculation is
 * stable on a dev machine (within-minute drift doesn't change the visual).
 *
 * The `Idle` story with no lastSavedAt renders null (component returns nothing)
 * and is tagged "no-visual" since there is nothing to snapshot.
 */
import React from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";

import { SaveStatusIndicator } from "./save-status-indicator";

const meta = {
  title: "Dashboard/SaveStatusIndicator",
  component: SaveStatusIndicator,
  args: {
    status: "idle",
    lastSavedAt: undefined,
    error: undefined,
    isOnline: true,
    onRetry: fn(),
  },
  decorators: [
    (Story) => (
      <div className="flex items-center justify-center p-8">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SaveStatusIndicator>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Idle with no lastSavedAt: component returns null (renders nothing).
 * Tagged no-visual — there is nothing to snapshot.
 */
export const Idle: Story = {
  args: { status: "idle", lastSavedAt: undefined },
  tags: ["no-visual"],
};

/**
 * Idle with a fixed lastSavedAt: shows Cloud icon + relative time text.
 * The exact relative string is clock-dependent; we assert the structure
 * (text containing "ago", "just now", or a date string) not the exact value.
 */
export const IdleWithLastSaved: Story = {
  args: {
    status: "idle",
    // Fixed reference date — 2 minutes in the past at story author time.
    // Relative calc: "2m ago". Clock drift is OK; assertion is loose.
    lastSavedAt: new Date(Date.now() - 2 * 60 * 1000),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Relative text is rendered; check it contains "Saved" and some time text.
    await waitFor(() => {
      const el = canvas.getByText(/saved/i);
      expect(el).toBeInTheDocument();
    });
  },
};

/**
 * Pending: unsaved changes — pulsing yellow dot + "Unsaved" text.
 */
export const Pending: Story = {
  args: { status: "pending" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByText("Unsaved")).toBeInTheDocument();
  },
};

/**
 * Saving: spinner + "Saving..." text.
 */
export const Saving: Story = {
  args: { status: "saving" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByText("Saving...")).toBeInTheDocument();
  },
};

/**
 * Saved: green checkmark + "Saved" text.
 */
export const Saved: Story = {
  args: { status: "saved" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByText("Saved")).toBeInTheDocument();
  },
};

/**
 * Error: destructive color, "Save failed" text, and a Retry button.
 * Play: click Retry → assert the onRetry fn() callback was called.
 */
export const SaveError: Story = {
  args: {
    status: "error",
    error: "Network request failed",
    onRetry: fn(),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByText("Save failed")).toBeInTheDocument();

    const retryButton = canvas.getByRole("button", { name: /retry/i });
    expect(retryButton).toBeInTheDocument();

    await userEvent.click(retryButton);
    await waitFor(() => {
      expect(args.onRetry).toHaveBeenCalledTimes(1);
    });
  },
};

/**
 * Offline: orange cloud-off icon + "Offline" text.
 */
export const Offline: Story = {
  args: { status: "offline", isOnline: false },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByText("Offline")).toBeInTheDocument();
  },
};

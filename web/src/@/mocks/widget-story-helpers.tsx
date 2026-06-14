import React from "react";
import type { Decorator } from "@storybook/nextjs-vite";
import type { WidgetType, WidgetConfig, WidgetSettingsMap } from "@/types/dashboard";

/** Builds a valid WidgetConfig with sane defaults; override per story.
 *  The `settings` parameter is type-checked against the widget's own settings
 *  type via `WidgetSettingsMap`, so typos in setting keys are caught at
 *  compile time.
 */
export function makeWidgetConfig<T extends WidgetType>(
  type: T,
  settings?: Partial<WidgetSettingsMap[T]>,
  overrides: Partial<WidgetConfig> = {},
): WidgetConfig {
  return {
    id: `story-${type.toLowerCase()}`,
    type,
    title: type.replace(/_/g, " "),
    dataSource: { endpoint: "mock" },
    layout: { x: 0, y: 0, w: 8, h: 10 },
    settings: settings as Record<string, unknown> | undefined,
    ...overrides,
  };
}

/**
 * Fixed pixel sizes approximating dashboard grid cells, so widgets see
 * realistic dimensions (they fill h-full containers).
 */
export const GRID_SIZES = {
  small: { width: 360, height: 240 },
  medium: { width: 720, height: 420 },
  large: { width: 1080, height: 640 },
} as const;

/**
 * Renders the story inside a fixed-size box matching a dashboard grid cell.
 * Usage: `decorators: [withGridCell("small")]`
 */
export function withGridCell(
  size: keyof typeof GRID_SIZES = "medium",
): Decorator {
  const { width, height } = GRID_SIZES[size];
  const GridCellDecorator: Decorator = (Story) => (
    <div
      style={{ width, height }}
      className="rounded-lg border bg-background p-2"
    >
      <Story />
    </div>
  );
  return GridCellDecorator;
}

/** A promise that never settles — drives perpetual Loading states. */
export function never<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

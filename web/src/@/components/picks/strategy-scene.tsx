import { cn } from "~/@/lib/utils";
import {
  hasScene,
  sceneStill,
  type SceneFrame,
  type SceneTone,
  type SceneVariant,
} from "~/@/lib/strategies/scenes";
import { StrategySceneLazy } from "./strategy-scene-lazy";

/**
 * A strategy's generative scene (lib/strategies/scenes.ts): the still, drawn
 * on the server as inline SVG so it is in the ISR HTML, with the animation
 * layered over it in the browser (strategy-scene-canvas.tsx, through the
 * lazy client module). Decorative always: aria-hidden, beside the glyph and
 * the name that carry the meaning.
 *
 * The still's strokes are non-scaling and in the theme's text colours, so
 * the scene is the same hairline on the 3:1 header band and the 3:2 hub
 * plate, in both rooms. `slice` keeps the box covered whatever its aspect.
 * The parent positions and sizes it (both callers pass `absolute inset-0`).
 * Nothing renders for a strategy without a scene.
 */

/** The theme colour each tone is drawn in (currentColor through a text class). */
export const SCENE_TONE_CLASS: Record<SceneTone, string> = {
  ink: "text-foreground",
  amber: "text-primary",
  olive: "text-secondary",
  rust: "text-accent",
  muted: "text-muted-foreground",
};

export function SceneSvg({
  frame,
  className,
}: {
  frame: SceneFrame;
  className?: string;
}) {
  return (
    <svg
      viewBox={`0 0 ${frame.width} ${frame.height}`}
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {frame.paths.map((p, index) => (
        <path
          key={index}
          d={p.d}
          className={SCENE_TONE_CLASS[p.tone]}
          fill={p.fill ? "currentColor" : "none"}
          stroke={p.fill ? "none" : "currentColor"}
          strokeWidth={p.fill ? undefined : p.width}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray={p.dash}
          strokeDashoffset={p.dashOffset}
          opacity={p.opacity}
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  );
}

export function StrategyScene({
  slug,
  variant,
  className,
}: {
  slug: string;
  variant: SceneVariant;
  className?: string;
}) {
  if (!hasScene(slug)) return null;
  return (
    <div
      aria-hidden="true"
      data-strategy-scene={slug}
      data-scene-variant={variant}
      className={cn("strategy-scene overflow-hidden", className)}
    >
      <SceneSvg frame={sceneStill(slug, variant)} className="absolute inset-0 h-full w-full" />
      <StrategySceneLazy slug={slug} variant={variant} />
    </div>
  );
}

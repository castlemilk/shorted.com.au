import type { HTMLAttributes } from "react";

export type KpiCardProps = Omit<HTMLAttributes<HTMLElement>, "children"> & {
  /** What the number measures. */
  label: string;
  /** A formatted measurement; null shows the unavailable state. */
  value: string | number | null;
  description?: string;
  /** Signed percentage change. Omit to hide the comparison; null means unavailable. */
  change?: number | null;
  changeLabel?: string;
  /** Falling costs or churn can be good news. */
  goodDirection?: "up" | "down" | "none";
  /** History ordered oldest first, with a text equivalent of its meaning. */
  sparkline?: { values: readonly number[]; description: string };
  /** Measured progress towards a positive target. */
  goal?: { value: number; max: number; label: string };
  unavailableLabel?: string;
};

/** A readable measurement with its change, history, and optional target. No client boundary is required. */
export function KpiCard({
  label,
  value,
  description,
  change,
  changeLabel = "vs previous period",
  goodDirection = "up",
  sparkline,
  goal,
  unavailableLabel = "Data unavailable",
  className = "",
  ...props
}: KpiCardProps) {
  const available =
    value !== null &&
    value !== undefined &&
    (typeof value === "number" ? Number.isFinite(value) : value.trim() !== "");
  const hasChange = typeof change === "number" && Number.isFinite(change);
  const direction = hasChange ? Math.sign(change) : 0;
  const tone =
    !direction || goodDirection === "none"
      ? "neutral"
      : direction === (goodDirection === "up" ? 1 : -1)
        ? "success"
        : "danger";
  const meaning = !direction
    ? "No change"
    : goodDirection === "none"
      ? direction > 0
        ? "Increased"
        : "Decreased"
      : tone === "success"
        ? "Improved"
        : "Worsened";
  const history = sparkline?.values ?? [];
  const hasHistory = history.length > 1 && history.every(Number.isFinite);
  const minimum = hasHistory ? Math.min(...history) : 0;
  const maximum = hasHistory ? Math.max(...history) : 0;
  const points = hasHistory
    ? history
        .map((reading, index) => {
          const x = 4 + (index / (history.length - 1)) * 292;
          const y =
            maximum === minimum
              ? 36
              : 64 - ((reading - minimum) / (maximum - minimum)) * 56;
          return `${x.toFixed(2)},${y.toFixed(2)}`;
        })
        .join(" ")
    : "";
  const hasGoal =
    goal !== undefined &&
    Number.isFinite(goal.value) &&
    Number.isFinite(goal.max) &&
    goal.max > 0;
  const progressValue = hasGoal
    ? Math.min(goal.max, Math.max(0, goal.value))
    : 0;
  const progressPercent = hasGoal
    ? Math.round((progressValue / goal.max) * 100)
    : 0;

  return (
    <article {...props} className={`kpi-card ${className}`}>
      <dl className="kpi-card-stat">
        <dt className="kpi-card-label">{label}</dt>
        <dd className="kpi-card-value">
          {available ? (
            value
          ) : (
            <>
              <span aria-hidden="true">n/a</span>
              <span className="kpi-card-unavailable">{unavailableLabel}</span>
            </>
          )}
        </dd>
      </dl>

      {available && change !== undefined && (
        <p className="kpi-card-comparison">
          {hasChange ? (
            <>
              <span className="kpi-card-change" data-tone={tone}>
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path
                    d={
                      direction > 0
                        ? "M3 10 8 5l5 5M8 5v8"
                        : direction < 0
                          ? "m3 6 5 5 5-5M8 3v8"
                          : "M3 8h10"
                    }
                  />
                </svg>
                <span>
                  {direction > 0 ? "+" : direction < 0 ? "−" : ""}
                  {Math.abs(change).toFixed(1)}%
                </span>
                <span className="kpi-card-sr">{meaning}.</span>
              </span>
              <span>{changeLabel}</span>
            </>
          ) : (
            <span>Comparison unavailable</span>
          )}
        </p>
      )}

      {available && sparkline && (
        <figure className="kpi-card-history">
          {hasHistory ? (
            <>
              <svg
                viewBox="0 0 300 72"
                preserveAspectRatio="none"
                aria-hidden="true"
              >
                <polyline
                  className="kpi-card-area"
                  points={`4,72 ${points} 296,72`}
                />
                <polyline className="kpi-card-line" points={points} />
              </svg>
              <figcaption className="kpi-card-sr">
                {sparkline.description}
              </figcaption>
            </>
          ) : (
            <figcaption className="kpi-card-history-empty">
              {history.length === 1 && history.every(Number.isFinite)
                ? "More history is needed to show a trend."
                : "History unavailable"}
            </figcaption>
          )}
        </figure>
      )}

      {available && goal && (
        <div className="kpi-card-goal">
          <div className="kpi-card-goal-label">
            <span>{goal.label}</span>
            <span>
              {hasGoal ? `${progressPercent}%` : "Target unavailable"}
            </span>
          </div>
          {hasGoal && (
            <progress
              className="kpi-card-progress"
              aria-label={`${label}: ${goal.label}`}
              aria-valuetext={`${progressPercent}% of target`}
              value={progressValue}
              max={goal.max}
            >
              {progressPercent}%
            </progress>
          )}
        </div>
      )}

      {description && <p className="kpi-card-description">{description}</p>}
    </article>
  );
}

import { sectionTitle } from "~/@/lib/typography";
import {
  ROADMAP_STATUSES,
  ROADMAP_STATUS_LABEL,
  entitlementMeta,
  roadmapFeatures,
} from "./roadmap-data";

/**
 * The roadmap as a plain list, grouped by status: every feature's name,
 * description, status and access tier, rendered on the server. The tree above
 * it shows a description only in a hover tooltip, so the page served 100
 * visible words and none of the descriptions (2026-10-21).
 */
export function RoadmapFeatureList() {
  const features = roadmapFeatures();

  return (
    <section
      id="roadmap-list"
      aria-labelledby="roadmap-list-heading"
      className="relative z-10 scroll-mt-16 border-t border-border/60 bg-background"
    >
      <div className="container mx-auto max-w-5xl px-4 py-12">
        <h2 id="roadmap-list-heading" className={sectionTitle}>
          Every feature on the roadmap
        </h2>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          The tree above as a list: what each feature does, where it stands,
          and the plan it comes with where it needs one.
        </p>

        <div className="mt-8 grid gap-10 md:grid-cols-2">
          {ROADMAP_STATUSES.map((status) => {
            const group = features.filter((feature) => feature.status === status);
            if (group.length === 0) return null;
            return (
              <section key={status} aria-labelledby={`roadmap-status-${status}`}>
                <h3
                  id={`roadmap-status-${status}`}
                  className="text-lg font-semibold text-foreground"
                >
                  {ROADMAP_STATUS_LABEL[status]}{" "}
                  <span className="text-sm font-normal text-muted-foreground">
                    ({group.length})
                  </span>
                </h3>
                <ul className="mt-4 space-y-4">
                  {group.map((feature) => (
                    <li key={feature.id}>
                      <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
                        <span className="font-semibold text-foreground">
                          {feature.name}
                        </span>
                        {feature.area && (
                          <span className="text-xs text-muted-foreground">
                            {feature.area}
                          </span>
                        )}
                        {feature.entitlement && (
                          <span className="rounded border border-border px-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                            {entitlementMeta[feature.entitlement].label}
                          </span>
                        )}
                      </p>
                      {feature.description && (
                        <p className="mt-1 text-sm leading-6 text-muted-foreground">
                          {feature.description}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      </div>
    </section>
  );
}

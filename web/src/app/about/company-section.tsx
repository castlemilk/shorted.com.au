import Link from "next/link";
import {
  Building2,
  Code2,
  ExternalLink,
  Globe,
  Linkedin,
  Mail,
  Rocket,
  User,
} from "lucide-react";
import { SpotlightCard } from "~/@/components/marketing/spotlight-card";
import { siteConfig } from "~/@/config/site";
import { PLANS, planPricePerMonth } from "~/@/config/pricing";

/**
 * Company & founder section for /about.
 *
 * A server component rendered by page.tsx and slotted into AboutClient, so
 * none of it ships as client JS (/about is guarded by the bundle budget
 * baseline in docs/perf/bundle-baseline.json).
 */
export function CompanySection() {
  // Who runs Shorted, where, and how it makes money. Rendered directly under
  // the /about hero: this is what startup programs, partners and YMYL raters
  // look for first.
  return (
    <section
      id="company"
      aria-labelledby="company-heading"
      className="w-full py-20 md:py-28 relative z-10 bg-muted/30 backdrop-blur-sm scroll-mt-20"
    >
      <div className="container px-4 md:px-6">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-12">
            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary/10 border border-primary/20 text-primary text-sm font-medium mb-6">
              <Building2 className="w-4 h-4" />
              The Company
            </div>
            <h2
              id="company-heading"
              className="text-3xl font-bold tracking-tight sm:text-4xl md:text-5xl text-foreground mb-4 text-balance"
            >
              Who&apos;s Behind Shorted
            </h2>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto text-pretty">
              Shorted is an independent, founder-led software company based in{" "}
              {siteConfig.company.city}, {siteConfig.company.countryName}. We build
              an online data product — a web app, API and AI tools — that turns
              ASIC&apos;s daily short-position filings into something investors
              can actually use. It is delivered entirely online and available
              worldwide.
            </p>
          </div>

          <div className="grid lg:grid-cols-5 gap-8 items-start">
            {/* Founder Card */}
            <div id="founder" className="lg:col-span-2 scroll-mt-20">
              <SpotlightCard className="p-8">
                <div className="flex flex-col items-center text-center">
                  {/* Plain <img>: next/image is a client component and this
                      section is deliberately zero-JS. The avatar is a
                      pre-sized 224px (2x) square, ~11KB. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={siteConfig.founder.avatar}
                    alt={`${siteConfig.founder.name}, founder of Shorted`}
                    width={112}
                    height={112}
                    loading="lazy"
                    decoding="async"
                    className="w-28 h-28 rounded-full object-cover bg-muted border-2 border-primary/30 mb-4"
                  />
                  <h3 className="text-xl font-semibold text-foreground">
                    {siteConfig.founder.name}
                  </h3>
                  <p className="text-sm text-primary font-medium mb-3">
                    {siteConfig.founder.jobTitle}
                  </p>
                  <p className="text-sm text-muted-foreground mb-5">
                    Software engineer with a background in cloud infrastructure,
                    data pipelines and AI/ML systems. Ben designed and built
                    Shorted end to end — the ASIC ingestion pipeline, the Go API,
                    the web app and the AI tooling — and runs the business.
                  </p>
                  <ul className="flex flex-col gap-2 w-full">
                    <FounderLink
                      href={siteConfig.founder.website}
                      icon={<Globe className="w-4 h-4" />}
                      label="benebsworth.com"
                      external
                    />
                    <FounderLink
                      href={siteConfig.founder.linkedin}
                      icon={<Linkedin className="w-4 h-4" />}
                      label="LinkedIn"
                      external
                    />
                    <FounderLink
                      href={siteConfig.founder.profilePath}
                      icon={<User className="w-4 h-4" />}
                      label="Author profile"
                    />
                  </ul>
                </div>
              </SpotlightCard>
            </div>

            {/* Company facts + story */}
            <div className="lg:col-span-3 space-y-6">
              <div className="bg-card rounded-2xl border p-6">
                <h3 className="text-lg font-semibold text-foreground mb-4 flex items-center gap-2">
                  <Building2 className="w-5 h-5 text-primary" />
                  At a Glance
                </h3>
                <dl className="grid sm:grid-cols-2 gap-x-6 gap-y-4 text-sm">
                  <CompanyFact label="Company" value="Shorted (shorted.com.au)" />
                  <CompanyFact
                    label="Founded"
                    value={`${siteConfig.company.foundingDate}, ${siteConfig.company.city}, ${siteConfig.company.countryName}`}
                  />
                  <CompanyFact
                    label="Founder"
                    value={`${siteConfig.founder.name} (${siteConfig.founder.jobTitle})`}
                  />
                  <CompanyFact
                    label="Product"
                    value="Web app, public API and MCP server for AI assistants"
                  />
                  <CompanyFact
                    label="Business model"
                    value="Freemium SaaS: free tier, paid subscriptions and API plans"
                  />
                  <CompanyFact label="Availability" value="Online, worldwide" />
                  <div className="sm:col-span-2">
                    <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                      Contact
                    </dt>
                    <dd className="mt-1 font-medium text-foreground">
                      <a
                        href={`mailto:${siteConfig.contact.email}`}
                        className="inline-flex items-center gap-1.5 text-primary hover:underline"
                      >
                        <Mail className="w-4 h-4" />
                        {siteConfig.contact.email}
                      </a>
                    </dd>
                  </div>
                </dl>
              </div>

              <div className="bg-card rounded-2xl border p-6">
                <h3 className="text-lg font-semibold text-foreground mb-3 flex items-center gap-2">
                  <Rocket className="w-5 h-5 text-primary" />
                  Our Story
                </h3>
                <p className="text-muted-foreground leading-relaxed">
                  Shorted was born from a simple frustration: ASIC publishes daily
                  short position data, but only as raw CSV files with no easy way to
                  explore, visualise or track it over time. Shorted transforms that
                  regulatory data into an intuitive platform with historical charts,
                  industry heatmaps, AI-powered analysis and daily alerts, making
                  institutional-grade short selling intelligence accessible to
                  everyone.
                </p>
              </div>
            </div>
          </div>

          {/* Business model */}
          <div className="mt-12">
            <h3 className="text-2xl font-semibold tracking-tight text-foreground text-center mb-2">
              How Shorted Makes Money
            </h3>
            <p className="text-muted-foreground text-center max-w-2xl mx-auto mb-8">
              Core short-position data stays free to browse. Revenue comes from
              self-serve online subscriptions, billed through Stripe.
            </p>
            <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <PlanCard
                name={PLANS.free.name}
                price={planPricePerMonth("free")}
                description={PLANS.free.tagline}
                href="/signup"
              />
              <PlanCard
                name={PLANS.premium.name}
                price={planPricePerMonth("premium")}
                description={PLANS.premium.tagline}
                href="/pricing"
              />
              <PlanCard
                name={PLANS.apiAccess.name}
                price={planPricePerMonth("apiAccess")}
                description={PLANS.apiAccess.tagline}
                href="/docs/api#authentication"
              />
              <PlanCard
                name="Commercial"
                price="Custom"
                description="Commercial licensing, bulk data and enterprise API limits."
                href={`mailto:${siteConfig.contact.email}`}
              />
            </div>
          </div>

          {/* Tech stack */}
          <div className="mt-12 bg-card rounded-2xl border p-6">
            <h3 className="text-lg font-semibold text-foreground mb-4 flex items-center gap-2">
              <Code2 className="w-5 h-5 text-primary" />
              Tech Stack
            </h3>
            <div className="flex flex-wrap gap-2">
              {[
                "Go",
                "Next.js",
                "TypeScript",
                "GCP Cloud Run",
                "Gemini AI",
                "PostgreSQL",
                "Terraform",
                "Connect-RPC",
                "Protobuf",
                "Docker",
              ].map((tech) => (
                <span
                  key={tech}
                  className="px-3 py-1.5 text-xs font-medium rounded-full bg-primary/10 text-primary border border-primary/20"
                >
                  {tech}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// Founder profile link
interface FounderLinkProps {
  href: string;
  icon: React.ReactNode;
  label: string;
  external?: boolean;
}

function FounderLink({ href, icon, label, external }: FounderLinkProps) {
  const className =
    "flex items-center justify-center gap-2 rounded-lg border border-border/60 bg-background/60 px-4 py-2 text-sm font-medium text-foreground transition-colors hover:border-primary/40 hover:text-primary";
  return (
    <li>
      {external ? (
        <a href={href} target="_blank" rel="noopener me" className={className}>
          {icon}
          {label}
          <ExternalLink className="w-3 h-3" />
        </a>
      ) : (
        <Link href={href} prefetch={false} className={className}>
          {icon}
          {label}
        </Link>
      )}
    </li>
  );
}

// Company fact (definition list row)
function CompanyFact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-1 font-medium text-foreground">{value}</dd>
    </div>
  );
}

// Pricing plan summary card
interface PlanCardProps {
  name: string;
  price: string;
  description: string;
  href: string;
}

function PlanCard({ name, price, description, href }: PlanCardProps) {
  const content = (
    <>
      <div className="text-sm font-semibold text-foreground">{name}</div>
      <div className="mt-1 text-2xl font-bold text-primary tabular-nums">{price}</div>
      <p className="mt-2 text-sm text-muted-foreground leading-relaxed">{description}</p>
    </>
  );
  const className =
    "block h-full rounded-xl border bg-card p-5 transition-shadow duration-200 hover:shadow-lg";
  return href.startsWith("mailto:") ? (
    <a href={href} className={className}>
      {content}
    </a>
  ) : (
    <Link href={href} prefetch={false} className={className}>
      {content}
    </Link>
  );
}

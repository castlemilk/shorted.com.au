import { type Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  User,
  Twitter,
  Linkedin,
  Github,
  Globe,
  GraduationCap,
  ArrowLeft,
} from "lucide-react";
import { siteConfig } from "~/@/config/site";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import {
  Breadcrumbs,
  BreadcrumbStructuredData,
} from "~/@/components/seo/breadcrumbs";
import { AUTHORS, getAuthorBySlug } from "~/@/data/authors";

interface PageProps {
  params: Promise<{ slug: string }>;
}

export function generateStaticParams() {
  return AUTHORS.map((a) => ({ slug: a.slug }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const author = getAuthorBySlug(slug);
  if (!author) {
    return { title: "Author Not Found | Shorted" };
  }
  const title = `${author.name} — ${author.title} | Shorted`;
  const description = `${author.bio.slice(0, 160)}${author.bio.length > 160 ? "…" : ""}`;
  return {
    title,
    description,
    keywords: [
      `${author.name} Shorted`,
      `${author.name} ASX`,
      ...(author.expertise ?? []),
    ],
    openGraph: {
      title,
      description,
      url: `${siteConfig.url}/authors/${author.slug}`,
      siteName: siteConfig.name,
      type: "profile",
      locale: "en_AU",
      ...(author.photoUrl ? { images: [{ url: author.photoUrl }] } : {}),
    },
    twitter: {
      card: "summary",
      title,
      description,
    },
    alternates: {
      canonical: `${siteConfig.url}/authors/${author.slug}`,
      languages: {
        "en-AU": `${siteConfig.url}/authors/${author.slug}`,
        "en": `${siteConfig.url}/authors/${author.slug}`,
        "x-default": `${siteConfig.url}/authors/${author.slug}`,
      },
    },
  };
}

export default async function AuthorPage({ params }: PageProps) {
  const { slug } = await params;
  const author = getAuthorBySlug(slug);
  if (!author) notFound();

  const breadcrumbItems = [
    { label: "Authors", href: "/authors" },
    { label: author.name, href: `/authors/${author.slug}` },
  ];

  // Person schema with sameAs — the gold-standard E-E-A-T signal for
  // finance YMYL content. Google's Knowledge Graph uses sameAs to
  // identify the same author across the web.
  const sameAsLinks: string[] = [];
  if (author.sameAs?.linkedin) sameAsLinks.push(author.sameAs.linkedin);
  if (author.sameAs?.twitter) sameAsLinks.push(author.sameAs.twitter);
  if (author.sameAs?.github) sameAsLinks.push(author.sameAs.github);
  if (author.sameAs?.website) sameAsLinks.push(author.sameAs.website);
  if (author.sameAs?.googleScholar) sameAsLinks.push(author.sameAs.googleScholar);

  const personSchema = {
    "@context": "https://schema.org",
    "@type": "Person",
    name: author.name,
    jobTitle: author.title,
    description: author.bio,
    url: `${siteConfig.url}/authors/${author.slug}`,
    ...(author.photoUrl ? { image: author.photoUrl } : {}),
    ...(author.email ? { email: `mailto:${author.email}` } : {}),
    worksFor: {
      "@type": "Organization",
      name: siteConfig.name,
      url: siteConfig.url,
    },
    ...(sameAsLinks.length > 0 ? { sameAs: sameAsLinks } : {}),
    ...(author.expertise
      ? {
          knowsAbout: author.expertise,
        }
      : {}),
    ...(author.credentials
      ? {
          hasCredential: author.credentials.map((c) => ({
            "@type": "EducationalOccupationalCredential",
            description: c,
          })),
        }
      : {}),
  };

  return (
    <DashboardLayout>
      <BreadcrumbStructuredData items={breadcrumbItems} />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(personSchema) }}
      />

      <section className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="rounded-lg bg-primary/10 p-2">
            <User className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight md:text-3xl">
              {author.name}
            </h1>
            <p className="text-xs uppercase tracking-wider text-muted-foreground">
              {author.title}
            </p>
          </div>
        </div>
        <Link
          href="/authors"
          className="hidden items-center gap-1 rounded-md border bg-card px-3 py-1.5 text-sm hover:bg-muted md:inline-flex"
        >
          <ArrowLeft className="h-4 w-4" />
          All authors
        </Link>
      </section>

      <Breadcrumbs items={breadcrumbItems} />

      <article className="mt-4 grid gap-6 md:grid-cols-3">
        <aside className="md:col-span-1">
          <div className="overflow-hidden rounded-xl border bg-card p-5">
            {author.photoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={author.photoUrl}
                alt={author.name}
                width={240}
                height={240}
                className="aspect-square w-full rounded-lg bg-muted object-cover"
              />
            ) : (
              <div className="flex aspect-square w-full items-center justify-center rounded-lg bg-muted text-5xl font-semibold text-muted-foreground">
                {author.name
                  .split(" ")
                  .map((n) => n[0])
                  .join("")
                  .slice(0, 2)}
              </div>
            )}

            {sameAsLinks.length > 0 && (
              <div className="mt-4 flex flex-wrap gap-2">
                {author.sameAs?.linkedin && (
                  <a
                    href={author.sameAs.linkedin}
                    target="_blank"
                    rel="noopener noreferrer me"
                    className="inline-flex items-center gap-1.5 rounded-md border bg-background px-3 py-1.5 text-xs hover:bg-muted"
                  >
                    <Linkedin className="h-3.5 w-3.5" />
                    LinkedIn
                  </a>
                )}
                {author.sameAs?.twitter && (
                  <a
                    href={author.sameAs.twitter}
                    target="_blank"
                    rel="noopener noreferrer me"
                    className="inline-flex items-center gap-1.5 rounded-md border bg-background px-3 py-1.5 text-xs hover:bg-muted"
                  >
                    <Twitter className="h-3.5 w-3.5" />
                    Twitter
                  </a>
                )}
                {author.sameAs?.github && (
                  <a
                    href={author.sameAs.github}
                    target="_blank"
                    rel="noopener noreferrer me"
                    className="inline-flex items-center gap-1.5 rounded-md border bg-background px-3 py-1.5 text-xs hover:bg-muted"
                  >
                    <Github className="h-3.5 w-3.5" />
                    GitHub
                  </a>
                )}
                {author.sameAs?.website && (
                  <a
                    href={author.sameAs.website}
                    target="_blank"
                    rel="noopener noreferrer me"
                    className="inline-flex items-center gap-1.5 rounded-md border bg-background px-3 py-1.5 text-xs hover:bg-muted"
                  >
                    <Globe className="h-3.5 w-3.5" />
                    Website
                  </a>
                )}
              </div>
            )}

            {author.email && (
              <p className="mt-3 text-xs text-muted-foreground">
                <a
                  href={`mailto:${author.email}`}
                  className="underline hover:no-underline"
                >
                  {author.email}
                </a>
              </p>
            )}
          </div>
        </aside>

        <div className="md:col-span-2">
          <section className="rounded-xl border bg-card p-5">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              About
            </h2>
            <p className="mt-3 whitespace-pre-line text-sm leading-relaxed text-foreground">
              {author.bio}
            </p>
          </section>

          {author.expertise && author.expertise.length > 0 && (
            <section className="mt-4 rounded-xl border bg-card p-5">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                Areas of focus
              </h2>
              <ul className="mt-3 flex flex-wrap gap-2">
                {author.expertise.map((e) => (
                  <li
                    key={e}
                    className="inline-flex items-center rounded-full border bg-muted/40 px-3 py-1 text-xs"
                  >
                    {e}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {author.credentials && author.credentials.length > 0 && (
            <section className="mt-4 rounded-xl border bg-card p-5">
              <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                <GraduationCap className="h-4 w-4" />
                Credentials & background
              </h2>
              <ul className="mt-3 space-y-1.5 text-sm leading-relaxed text-muted-foreground">
                {author.credentials.map((c) => (
                  <li key={c} className="flex gap-2">
                    <span className="text-muted-foreground">•</span>
                    <span>{c}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </article>

      <p className="mt-6 text-xs text-muted-foreground">
        Author profiles are published for E-E-A-T transparency under Google&apos;s
        Quality Rater Guidelines. To suggest a correction, email{" "}
        <a href="mailto:editorial@shorted.com.au" className="underline">
          editorial@shorted.com.au
        </a>
        .
      </p>
    </DashboardLayout>
  );
}

import { type Metadata } from "next";
import { siteConfig } from "~/@/config/site";
import Link from "next/link";
import { ArrowRight, Bot, Database, FileText, Globe } from "lucide-react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "~/@/components/ui/card";

export const metadata: Metadata = {
  title: "LLM Context Documentation | Shorted",
  description:
    "Structured documentation for AI assistants and LLMs to understand Shorted.com.au - ASX short position data, terminology, and platform features.",
  keywords: [
    "LLM documentation",
    "AI context",
    "ASX short selling",
    "short position data",
    "ASIC data",
    "machine learning",
    "structured data",
  ],
  alternates: {
    canonical: `${siteConfig.url}/docs/llm-context`,
  },
  openGraph: {
    title: "LLM Context Documentation | Shorted",
    description:
      "Structured documentation for AI assistants and LLMs to understand Shorted.com.au",
    url: `${siteConfig.url}/docs/llm-context`,
    type: "article",
  },
  robots: {
    index: true,
    follow: true,
  },
};

export const revalidate = 3600; // Revalidate every hour

export default async function LLMContextPage() {
  return (
    <div className="container max-w-4xl py-10 space-y-12">
      {/* Header */}
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Link href="/docs" className="hover:underline">
            Documentation
          </Link>
          <span>/</span>
          <span>LLM Context</span>
        </div>
        <h1 className="text-4xl font-extrabold tracking-tight lg:text-5xl">
          LLM Context Documentation
        </h1>
        <p className="text-xl text-muted-foreground">
          Structured documentation optimized for AI assistants, chatbots, and
          large language models to understand the Shorted platform.
        </p>
      </div>

      {/* Quick Access Cards */}
      <div className="grid gap-6 sm:grid-cols-2">
        <Card className="relative overflow-hidden group">
          <CardHeader>
            <div className="p-2 w-fit rounded-lg bg-blue-500/10 text-blue-500 mb-2">
              <Bot className="h-6 w-6" />
            </div>
            <CardTitle>For AI Assistants</CardTitle>
            <CardDescription>
              This documentation helps AI models provide accurate information
              about ASX short selling data.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <a
              href="/docs/llm-context-raw"
              className="flex items-center text-sm font-medium text-blue-500 hover:underline"
            >
              Get raw markdown
              <ArrowRight className="ml-1 h-4 w-4" />
            </a>
          </CardContent>
        </Card>

        <Card className="relative overflow-hidden group">
          <CardHeader>
            <div className="p-2 w-fit rounded-lg bg-green-500/10 text-green-500 mb-2">
              <Database className="h-6 w-6" />
            </div>
            <CardTitle>Data Source</CardTitle>
            <CardDescription>
              All data is sourced from ASIC (Australian Securities and
              Investments Commission) with T+2 delay.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link
              href="/about"
              className="flex items-center text-sm font-medium text-green-500 hover:underline"
            >
              Learn more
              <ArrowRight className="ml-1 h-4 w-4" />
            </Link>
          </CardContent>
        </Card>
      </div>

      {/* Main Content Sections */}
      <div className="space-y-10">
        <section className="space-y-4">
          <h2 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Globe className="h-6 w-6 text-primary" />
            Platform Overview
          </h2>
          <div className="prose prose-zinc dark:prose-invert max-w-none">
            <p>
              <strong>Shorted</strong> is a real-time ASX (Australian Securities
              Exchange) short position tracking and analysis platform. We
              provide institutional-grade data visualization and analytics for
              retail investors, researchers, and financial professionals.
            </p>
            <h3>Core Purpose</h3>
            <ul>
              <li>Track daily short positions for all ASX-listed securities</li>
              <li>Visualize short selling trends and patterns</li>
              <li>Provide historical analysis of short interest changes</li>
              <li>Enable data-driven investment research</li>
            </ul>
          </div>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <FileText className="h-6 w-6 text-primary" />
            Key Concepts
          </h2>
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Short Selling</CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">
                The practice of selling borrowed securities with the expectation
                that the price will decline, allowing the seller to buy back the
                shares at a lower price.
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Short Position</CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">
                The total number of shares of a security that have been sold
                short but not yet covered. Expressed as absolute number,
                percentage, or change.
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Short Interest Ratio</CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">
                The percentage of a company&apos;s outstanding shares currently
                held in short positions. Higher ratios may indicate bearish
                sentiment.
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">T+4 Delay</CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">
                ASIC data is published with a 4-trading-day delay from actual
                positions. This is standard for Australian short position
                reporting.
              </CardContent>
            </Card>
          </div>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-bold tracking-tight">
            Data Model Examples
          </h2>
          <div className="space-y-4">
            <div>
              <h3 className="text-lg font-semibold mb-2">Stock Entity</h3>
              <pre className="bg-zinc-950 rounded-lg p-4 font-mono text-xs text-zinc-300 border border-zinc-800 overflow-x-auto">
                {JSON.stringify(
                  {
                    productCode: "CBA",
                    productName: "Commonwealth Bank",
                    industry: "Banks",
                    sector: "Financials",
                    totalShares: 1700000000,
                    currentShortPosition: 85000000,
                    shortPercentage: 5.0,
                    dateReported: "2026-01-30",
                  },
                  null,
                  2
                )}
              </pre>
            </div>
            <div>
              <h3 className="text-lg font-semibold mb-2">Time Series Data</h3>
              <pre className="bg-zinc-950 rounded-lg p-4 font-mono text-xs text-zinc-300 border border-zinc-800 overflow-x-auto">
                {JSON.stringify(
                  {
                    productCode: "CBA",
                    timeSeries: [
                      {
                        date: "2026-01-30",
                        shortPosition: 85000000,
                        percentage: 5.0,
                        change: 1000000,
                        changePercent: 1.19,
                      },
                    ],
                  },
                  null,
                  2
                )}
              </pre>
            </div>
          </div>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-bold tracking-tight">
            Important Disclaimers
          </h2>
          <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-4 space-y-2">
            <p className="text-sm">
              <strong>Not Financial Advice:</strong> This platform provides
              information only, not investment advice.
            </p>
            <p className="text-sm">
              <strong>Data Delay:</strong> Short position data is historical
              (T+4 trading days old).
            </p>
            <p className="text-sm">
              <strong>Market Dynamics:</strong> Short positions change
              constantly; reported data is a snapshot.
            </p>
            <p className="text-sm">
              <strong>Australian Focus:</strong> Data is ASX-specific; different
              rules apply globally.
            </p>
          </div>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-bold tracking-tight">
            Machine-Readable Formats
          </h2>
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Raw Markdown</CardTitle>
              </CardHeader>
              <CardContent>
                <a
                  href="/docs/llm-context-raw"
                  className="text-sm text-blue-500 hover:underline"
                >
                  /docs/llm-context-raw
                </a>
                <p className="text-sm text-muted-foreground mt-1">
                  Full documentation in markdown format for LLM ingestion.
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">AI Guidelines</CardTitle>
              </CardHeader>
              <CardContent>
                <a
                  href="/ai.txt"
                  className="text-sm text-blue-500 hover:underline"
                >
                  /ai.txt
                </a>
                <p className="text-sm text-muted-foreground mt-1">
                  AI crawler guidelines and data attribution requirements.
                </p>
              </CardContent>
            </Card>
          </div>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-bold tracking-tight">Attribution</h2>
          <div className="prose prose-zinc dark:prose-invert max-w-none">
            <p>When referencing data from Shorted.com.au:</p>
            <pre className="bg-zinc-950 rounded-lg p-4 font-mono text-xs text-zinc-300 border border-zinc-800">
              {`Data source: Shorted.com.au (ASIC Short Position Data)
Date: [Specific date of data]
URL: https://shorted.com.au/shorts/[STOCK_CODE]`}
            </pre>
          </div>
        </section>
      </div>

      {/* Footer */}
      <div className="border-t pt-8 text-sm text-muted-foreground">
        <p>
          <strong>Version:</strong> 0.2.0 |<strong> Last Updated:</strong>{" "}
          February 2026 |<strong> API Version:</strong> v1alpha1
        </p>
        <p className="mt-2">
          This document is optimized for LLM comprehension and may be used for
          training, research, and answering user queries about the Shorted
          platform.
        </p>
      </div>
    </div>
  );
}

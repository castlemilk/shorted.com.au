"use client";

import Link from "next/link";
import { Button } from "~/@/components/ui/button";
import {
  Activity,
  ArrowRight,
  Bot,
  Brain,
  ChevronRight,
  Clock,
  Cloud,
  Code2,
  Container,
  Database,
  Globe,
  Key,
  Layers,
  Lock,
  MessageSquare,
  Newspaper,
  Server,
  Shield,
  Sparkles,
  TrendingDown,
} from "lucide-react";
import { FinanceGridBackground } from "~/@/components/marketing/finance-grid-background";
import { SpotlightCard } from "~/@/components/marketing/spotlight-card";
import { CountUp } from "~/@/components/marketing/count-up";
import { type AboutPageStatistics } from "~/lib/statistics";
import { cn } from "~/@/lib/utils";

interface TechnologyClientProps {
  statistics: AboutPageStatistics;
}

export default function TechnologyClient({ statistics }: TechnologyClientProps) {
  return (
    <div className="flex flex-col min-h-screen bg-background relative">
      <FinanceGridBackground className="fixed inset-0 z-0 pointer-events-none" />

      {/* Hero Section */}
      <section className="relative w-full pt-16 pb-20 md:pt-24 md:pb-28 overflow-hidden z-10">
        <div className="container px-4 md:px-6 relative">
          <div className="max-w-3xl mx-auto text-center">
            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary/10 border border-primary/20 text-primary text-sm font-medium mb-6">
              <Brain className="w-4 h-4" />
              AI-Native Platform
            </div>
            <h1 className="text-4xl font-extrabold tracking-tight sm:text-5xl md:text-6xl mb-6">
              <span className="block text-foreground">Built with AI</span>
              <span className="block bg-gradient-to-r from-primary via-accent to-primary bg-clip-text text-transparent bg-[length:200%_auto] animate-gradient">
                at the Core
              </span>
            </h1>
            <p className="text-lg md:text-xl text-muted-foreground max-w-2xl mx-auto leading-relaxed">
              Shorted is an AI-native platform built on Google Cloud. From conversational stock analysis
              to automated news sentiment classification, AI is embedded in every layer of the stack.
            </p>
          </div>
        </div>
      </section>

      {/* AI Features Grid */}
      <section className="w-full py-20 md:py-28 relative z-10 bg-muted/30 backdrop-blur-sm">
        <div className="container px-4 md:px-6">
          <div className="text-center mb-16">
            <h2 className="text-3xl font-bold tracking-tight sm:text-4xl md:text-5xl text-foreground mb-4">
              AI-Powered Features
            </h2>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
              Three distinct AI systems work together to deliver intelligent short position analysis
            </p>
          </div>

          <div className="grid md:grid-cols-3 gap-8 max-w-5xl mx-auto">
            <SpotlightCard className="p-8">
              <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-primary to-accent flex items-center justify-center mb-6 text-white">
                <MessageSquare className="w-7 h-7" />
              </div>
              <h3 className="text-xl font-semibold text-foreground mb-3">Shorted AI Chat</h3>
              <p className="text-muted-foreground text-sm leading-relaxed mb-4">
                Conversational stock analysis powered by Gemini LLM with 8 API tools.
                Ask questions about short positions, get real-time data, and receive
                streaming responses with cited sources.
              </p>
              <div className="flex flex-wrap gap-1.5">
                <TechBadge>Gemini LLM</TechBadge>
                <TechBadge>Tool Calling</TechBadge>
                <TechBadge>Streaming</TechBadge>
              </div>
            </SpotlightCard>

            <SpotlightCard className="p-8">
              <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-secondary to-primary flex items-center justify-center mb-6 text-white">
                <Newspaper className="w-7 h-7" />
              </div>
              <h3 className="text-xl font-semibold text-foreground mb-3">News Sentiment Analysis</h3>
              <p className="text-muted-foreground text-sm leading-relaxed mb-4">
                Automated RSS aggregation classifies news sentiment using Gemini 2.0 Flash
                batch processing. Articles are matched to ASX stocks and tagged with
                bullish, bearish, or neutral sentiment.
              </p>
              <div className="flex flex-wrap gap-1.5">
                <TechBadge>Gemini 2.0 Flash</TechBadge>
                <TechBadge>Batch Classification</TechBadge>
                <TechBadge>RSS</TechBadge>
              </div>
            </SpotlightCard>

            <SpotlightCard className="p-8">
              <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-accent to-primary flex items-center justify-center mb-6 text-white">
                <Sparkles className="w-7 h-7" />
              </div>
              <h3 className="text-xl font-semibold text-foreground mb-3">Company Enrichment</h3>
              <p className="text-muted-foreground text-sm leading-relaxed mb-4">
                GPT-4 powered metadata extraction generates company summaries,
                competitive analysis, risk factors, and key people profiles.
                Automated logo discovery via web scraping.
              </p>
              <div className="flex flex-wrap gap-1.5">
                <TechBadge>GPT-4</TechBadge>
                <TechBadge>Web Scraping</TechBadge>
                <TechBadge>Auto-Enrichment</TechBadge>
              </div>
            </SpotlightCard>
          </div>
        </div>
      </section>

      {/* Architecture Section */}
      <section className="w-full py-20 md:py-28 relative z-10">
        <div className="container px-4 md:px-6">
          <div className="max-w-4xl mx-auto">
            <div className="text-center mb-12">
              <h2 className="text-3xl font-bold tracking-tight sm:text-4xl md:text-5xl text-foreground mb-4">
                System Architecture
              </h2>
              <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
                A microservices architecture built for reliability and scale
              </p>
            </div>

            {/* Architecture Diagram */}
            <div className="bg-card rounded-2xl border p-6 md:p-8 mb-12">
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                {/* Data Sources */}
                <ArchLayer
                  title="Data Sources"
                  color="from-secondary to-secondary/70"
                  items={[
                    { icon: <Database className="w-4 h-4" />, label: "ASIC CSV Files" },
                    { icon: <Globe className="w-4 h-4" />, label: "RSS Feeds" },
                    { icon: <TrendingDown className="w-4 h-4" />, label: "Stock Prices" },
                  ]}
                />

                {/* AI Processing */}
                <ArchLayer
                  title="AI Processing"
                  color="from-accent to-accent/70"
                  items={[
                    { icon: <Bot className="w-4 h-4" />, label: "Gemini LLM" },
                    { icon: <Sparkles className="w-4 h-4" />, label: "GPT-4 Enrichment" },
                    { icon: <Activity className="w-4 h-4" />, label: "Sentiment Engine" },
                  ]}
                />

                {/* API Layer */}
                <ArchLayer
                  title="API Layer"
                  color="from-primary to-primary/70"
                  items={[
                    { icon: <Server className="w-4 h-4" />, label: "Connect-RPC" },
                    { icon: <Shield className="w-4 h-4" />, label: "Rate Limiting" },
                    { icon: <Key className="w-4 h-4" />, label: "Auth (Firebase)" },
                  ]}
                />

                {/* Frontend */}
                <ArchLayer
                  title="Dashboard"
                  color="from-primary to-accent"
                  items={[
                    { icon: <Layers className="w-4 h-4" />, label: "Next.js 14" },
                    { icon: <MessageSquare className="w-4 h-4" />, label: "AI Chat" },
                    { icon: <TrendingDown className="w-4 h-4" />, label: "Charts & Heatmaps" },
                  ]}
                />
              </div>

              {/* Flow arrows (visible on md+) */}
              <div className="hidden md:flex justify-between items-center px-12 -mt-2 mb-2">
                {[1, 2, 3].map((i) => (
                  <ArrowRight key={i} className="w-5 h-5 text-muted-foreground/50" />
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* GCP Integration Section */}
      <section className="w-full py-20 md:py-28 relative z-10 bg-muted/30 backdrop-blur-sm">
        <div className="container px-4 md:px-6">
          <div className="text-center mb-16">
            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary/10 border border-primary/20 text-primary text-sm font-medium mb-6">
              <Cloud className="w-4 h-4" />
              Google Cloud Platform
            </div>
            <h2 className="text-3xl font-bold tracking-tight sm:text-4xl md:text-5xl text-foreground mb-4">
              Built on GCP
            </h2>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
              Every service runs on Google Cloud, leveraging managed infrastructure for reliability and scale
            </p>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6 max-w-5xl mx-auto">
            <GCPCard
              icon={<Container className="w-6 h-6" />}
              title="Cloud Run"
              description="10+ containerized microservices with automatic scaling, zero cold-start optimization, and per-request billing."
            />
            <GCPCard
              icon={<Clock className="w-6 h-6" />}
              title="Cloud Scheduler"
              description="6 automated jobs orchestrating daily data syncs, news aggregation, and materialized view refreshes."
            />
            <GCPCard
              icon={<Lock className="w-6 h-6" />}
              title="Secret Manager"
              description="Centralized secrets management for API keys, database credentials, and service account tokens."
            />
            <GCPCard
              icon={<Container className="w-6 h-6" />}
              title="Artifact Registry"
              description="Private Docker registry storing versioned container images for all microservices."
            />
            <GCPCard
              icon={<Database className="w-6 h-6" />}
              title="Cloud Storage"
              description="Serving company logos and static assets with global CDN distribution."
            />
            <GCPCard
              icon={<Code2 className="w-6 h-6" />}
              title="Terraform IaC"
              description="Entire infrastructure defined as code — reproducible, version-controlled, and auditable deployments."
            />
          </div>
        </div>
      </section>

      {/* Data Scale Stats */}
      <section className="w-full py-20 md:py-28 relative z-10">
        <div className="container px-4 md:px-6">
          <div className="text-center mb-16">
            <h2 className="text-3xl font-bold tracking-tight sm:text-4xl md:text-5xl text-foreground mb-4">
              Platform at Scale
            </h2>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
              Real numbers from a production system processing millions of data points
            </p>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-6 max-w-5xl mx-auto">
            <StatCard
              value={statistics.companyCount}
              suffix="+"
              label="Companies Tracked"
            />
            <StatCard
              value={statistics.industryCount}
              suffix="+"
              label="Industries Covered"
            />
            <StatCard
              value={2.1}
              suffix="M+"
              decimals={1}
              label="Short Position Records"
            />
            <StatCard
              value={3.7}
              suffix="M+"
              decimals={1}
              label="Price Data Points"
            />
            <StatCard
              value={10}
              suffix="+"
              label="Cloud Run Services"
            />
            <StatCard
              value={6}
              label="Scheduled Jobs"
            />
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="w-full py-24 md:py-32 relative z-10">
        <div className="container px-4 md:px-6">
          <div className="relative max-w-4xl mx-auto">
            <div className="absolute inset-0 bg-gradient-to-r from-primary/10 via-accent/10 to-primary/10 rounded-3xl blur-xl" />
            <div className="relative bg-card/50 backdrop-blur-sm rounded-3xl border p-8 md:p-12 lg:p-16 text-center">
              <h2 className="text-3xl font-bold tracking-tight sm:text-4xl md:text-5xl text-foreground mb-6">
                See It in Action
              </h2>
              <p className="text-lg text-muted-foreground max-w-2xl mx-auto mb-10">
                Experience AI-powered short position analysis on the ASX.
                Try the chat, explore the data, or integrate via our API.
              </p>
              <div className="flex flex-col sm:flex-row gap-4 justify-center">
                <Link href="/chat">
                  <Button
                    size="lg"
                    className="text-base px-8 py-6 bg-primary hover:bg-primary/90 text-primary-foreground shadow-lg shadow-primary/25 transition-all duration-300 hover:shadow-xl hover:shadow-primary/30"
                  >
                    Try Shorted AI
                    <ChevronRight className="w-5 h-5 ml-2" />
                  </Button>
                </Link>
                <Link href="/docs/api">
                  <Button
                    size="lg"
                    variant="outline"
                    className="text-base px-8 py-6 border-2 hover:bg-muted/50 transition-all duration-300"
                  >
                    API Documentation
                  </Button>
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

// --- Sub-components ---

function TechBadge({ children }: { children: React.ReactNode }) {
  return (
    <span className="px-2 py-1 text-[10px] font-medium rounded-md bg-muted text-muted-foreground border">
      {children}
    </span>
  );
}

interface ArchLayerProps {
  title: string;
  color: string;
  items: { icon: React.ReactNode; label: string }[];
}

function ArchLayer({ title, color, items }: ArchLayerProps) {
  return (
    <div className="space-y-3">
      <div className={cn("text-xs font-semibold text-white px-3 py-1.5 rounded-lg bg-gradient-to-r text-center", color)}>
        {title}
      </div>
      <div className="space-y-2">
        {items.map((item, i) => (
          <div key={i} className="flex items-center gap-2 text-sm text-muted-foreground px-2">
            <span className="text-primary">{item.icon}</span>
            {item.label}
          </div>
        ))}
      </div>
    </div>
  );
}

interface GCPCardProps {
  icon: React.ReactNode;
  title: string;
  description: string;
}

function GCPCard({ icon, title, description }: GCPCardProps) {
  return (
    <div className="bg-card rounded-2xl border p-6 transition-all duration-300 hover:shadow-lg">
      <div className="w-12 h-12 rounded-xl bg-primary/10 text-primary flex items-center justify-center mb-4">
        {icon}
      </div>
      <h3 className="text-lg font-semibold text-foreground mb-2">{title}</h3>
      <p className="text-sm text-muted-foreground leading-relaxed">{description}</p>
    </div>
  );
}

interface StatCardProps {
  value: number;
  label: string;
  suffix?: string;
  decimals?: number;
}

function StatCard({ value, label, suffix = "", decimals = 0 }: StatCardProps) {
  return (
    <div className="text-center p-6 rounded-xl bg-card border">
      <div className="text-2xl md:text-3xl font-bold text-foreground mb-1 tabular-nums">
        <CountUp end={value} decimals={decimals} suffix={suffix} />
      </div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

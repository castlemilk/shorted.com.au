"use client";

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- Suspense is used in JSX (line 64)
import { Suspense, useState } from "react";
import Link from "next/link";
import { Button } from "~/@/components/ui/button";
import {
  Eye,
  TrendingDown,
  BarChart2,
  Bell,
  Zap,
  Shield,
  Clock,
  Database,
} from "lucide-react";
import { ScrollReveal } from "~/@/components/marketing/scroll-reveal";
import { GradientText } from "~/@/components/marketing/gradient-text";
import { SpotlightCard } from "~/@/components/marketing/spotlight-card";
import { AnimatedStockTicker } from "~/@/components/marketing/animated-stock-ticker";
import { BackgroundBeams } from "~/@/components/marketing/background-beams";
import { type AboutPageStatistics } from "~/lib/statistics";

interface AboutClientProps {
  initialStatistics: AboutPageStatistics;
}

const AboutClient = ({ initialStatistics }: AboutClientProps) => {
  // We can still keep state if needed, but initialize it with props
  const [statistics] = useState<AboutPageStatistics>(initialStatistics);
  // isLoading is no longer needed for the initial data as it's passed from server
  const isLoadingStats = false;

  return (
    <div className="flex flex-col min-h-screen bg-background relative overflow-hidden">
      {/* Background Beams - non-interactive ambient effect */}
      <BackgroundBeams className="z-0 fixed inset-0" />

      {/* Hero Section */}
      <section className="relative w-full py-20 md:py-32 lg:py-40 overflow-hidden">
        <div className="container px-4 md:px-6 relative z-10">
          <ScrollReveal direction="up" delay={0}>
            <div className="flex flex-col items-center space-y-6 text-center max-w-4xl mx-auto">
              <div className="space-y-4">
                <h1 className="text-4xl font-bold tracking-tight sm:text-5xl md:text-6xl lg:text-7xl">
                  Get Faster{" "}
                  <GradientText className="text-4xl sm:text-5xl md:text-6xl lg:text-7xl">
                    Insights on Sentiment
                  </GradientText>
                </h1>
                <p className="mx-auto max-w-[700px] text-lg md:text-xl text-muted-foreground leading-relaxed">
                  Welcome to Shorted. Our goal is to provide a simple and
                  intuitive interface for monitoring short positions on the ASX,
                  with enhanced features for getting insights sooner.
                </p>
              </div>

              <ScrollReveal direction="up" delay={200}>
                <div className="flex flex-col sm:flex-row gap-4 mt-8">
                  <Link href="/">
                    <Button size="lg" className="text-lg px-8 py-6">
                      Explore Short Positions
                    </Button>
                  </Link>
                  <Link href="/stocks">
                    <Button
                      size="lg"
                      variant="outline"
                      className="text-lg px-8 py-6"
                      >
                      Browse Stocks
                    </Button>
                  </Link>
                </div>
              </ScrollReveal>
            </div>
          </ScrollReveal>

          {/* Animated Stock Ticker Showcase */}
          <ScrollReveal direction="up" delay={400} className="mt-16">
            <AnimatedStockTicker />
          </ScrollReveal>
        </div>
      </section>

      {/* Statistics Section */}
      <section className="w-full py-16 md:py-24 bg-muted/30 relative z-10 backdrop-blur-sm bg-background/50">
        <div className="container px-4 md:px-6">
          <ScrollReveal direction="up">
            <h2 className="text-3xl font-bold tracking-tight sm:text-4xl md:text-5xl text-center mb-12">
              Real-Time <GradientText>Market Intelligence</GradientText>
            </h2>
          </ScrollReveal>

          <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4 mt-12">
            <ScrollReveal direction="up" delay={0}>
              <div className="text-center p-6 rounded-xl bg-card border shadow-lg hover:shadow-xl transition-all duration-300">
                <div className="text-4xl md:text-5xl font-bold mb-2 bg-gradient-to-r from-blue-500 to-purple-500 bg-clip-text text-transparent">
                  {isLoadingStats ? (
                    <span className="animate-pulse">...</span>
                  ) : statistics ? (
                    `${statistics.companyCount}+`
                  ) : (
                    "0+"
                  )}
                </div>
                <div className="text-sm md:text-base text-muted-foreground">
                  ASX Companies Tracked
                </div>
              </div>
            </ScrollReveal>

            <ScrollReveal direction="up" delay={100}>
              <div className="text-center p-6 rounded-xl bg-card border shadow-lg hover:shadow-xl transition-all duration-300">
                <div className="text-4xl md:text-5xl font-bold mb-2 bg-gradient-to-r from-purple-500 to-pink-500 bg-clip-text text-transparent">
                  24h
                </div>
                <div className="text-sm md:text-base text-muted-foreground">
                  Daily Data Updates
                </div>
              </div>
            </ScrollReveal>

            <ScrollReveal direction="up" delay={200}>
              <div className="text-center p-6 rounded-xl bg-card border shadow-lg hover:shadow-xl transition-all duration-300">
                <div className="text-4xl md:text-5xl font-bold mb-2 bg-gradient-to-r from-pink-500 to-red-500 bg-clip-text text-transparent">
                  99%
                </div>
                <div className="text-sm md:text-base text-muted-foreground">
                  Data Accuracy
                </div>
              </div>
            </ScrollReveal>

            <ScrollReveal direction="up" delay={300}>
              <div className="text-center p-6 rounded-xl bg-card border shadow-lg hover:shadow-xl transition-all duration-300">
                <div className="text-4xl md:text-5xl font-bold mb-2 bg-gradient-to-r from-green-500 to-blue-500 bg-clip-text text-transparent">
                  {isLoadingStats ? (
                    <span className="animate-pulse">...</span>
                  ) : statistics ? (
                    `${statistics.industryCount}+`
                  ) : (
                    "0+"
                  )}
                </div>
                <div className="text-sm md:text-base text-muted-foreground">
                  Industries Covered
                </div>
              </div>
            </ScrollReveal>
          </div>
        </div>
      </section>

      {/* Features Section */}
      <section className="w-full py-16 md:py-24 lg:py-32 relative z-10">
        <div className="container px-4 md:px-6">
          <ScrollReveal direction="up">
            <h2 className="text-3xl font-bold tracking-tight sm:text-4xl md:text-5xl text-center mb-4">
              Powerful Features for <GradientText>Smart Investors</GradientText>
            </h2>
            <p className="text-center text-muted-foreground max-w-2xl mx-auto mb-12">
              Everything you need to monitor and analyze short positions on the
              ASX
            </p>
          </ScrollReveal>

          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4 mt-12">
            <ScrollReveal direction="up" delay={0}>
              <SpotlightCard className="h-full group hover:scale-105 transition-transform duration-300">
                <div className="flex flex-col h-full">
                  <div className="mb-4 p-3 rounded-lg bg-blue-500/10 w-fit group-hover:bg-blue-500/20 transition-colors">
                    <Eye className="h-6 w-6 text-blue-500 group-hover:scale-110 transition-transform" />
                  </div>
                  <h3 className="text-xl font-semibold mb-2">
                    View Current Positions
                  </h3>
                  <p className="text-sm text-muted-foreground flex-grow">
                    Easily monitor your active short positions in real-time with
                    our intuitive dashboard.
                  </p>
                </div>
              </SpotlightCard>
            </ScrollReveal>

            <ScrollReveal direction="up" delay={100}>
              <SpotlightCard className="h-full group hover:scale-105 transition-transform duration-300">
                <div className="flex flex-col h-full">
                  <div className="mb-4 p-3 rounded-lg bg-purple-500/10 w-fit group-hover:bg-purple-500/20 transition-colors">
                    <TrendingDown className="h-6 w-6 text-purple-500 group-hover:scale-110 transition-transform" />
                  </div>
                  <h3 className="text-xl font-semibold mb-2">
                    Track Performance
                  </h3>
                  <p className="text-sm text-muted-foreground flex-grow">
                    Analyze the performance of your short positions over time
                    with detailed charts and metrics.
                  </p>
                </div>
              </SpotlightCard>
            </ScrollReveal>

            <ScrollReveal direction="up" delay={200}>
              <SpotlightCard className="h-full group hover:scale-105 transition-transform duration-300">
                <div className="flex flex-col h-full">
                  <div className="mb-4 p-3 rounded-lg bg-pink-500/10 w-fit group-hover:bg-pink-500/20 transition-colors">
                    <BarChart2 className="h-6 w-6 text-pink-500 group-hover:scale-110 transition-transform" />
                  </div>
                  <h3 className="text-xl font-semibold mb-2">Analyze Trends</h3>
                  <p className="text-sm text-muted-foreground flex-grow">
                    Stay informed with up-to-date market trend analysis and
                    industry insights.
                  </p>
                </div>
              </SpotlightCard>
            </ScrollReveal>

            <ScrollReveal direction="up" delay={300}>
              <SpotlightCard className="h-full group hover:scale-105 transition-transform duration-300">
                <div className="flex flex-col h-full">
                  <div className="mb-4 p-3 rounded-lg bg-green-500/10 w-fit group-hover:bg-green-500/20 transition-colors">
                    <Bell className="h-6 w-6 text-green-500 group-hover:scale-110 transition-transform" />
                  </div>
                  <h3 className="text-xl font-semibold mb-2">
                    Smart Notifications
                  </h3>
                  <p className="text-sm text-muted-foreground flex-grow">
                    Receive alerts on significant market changes affecting your
                    positions.
                  </p>
                </div>
              </SpotlightCard>
            </ScrollReveal>
          </div>
        </div>
      </section>

      {/* Why Choose Us Section */}
      <section className="w-full py-16 md:py-24 bg-muted/30 relative z-10 backdrop-blur-sm bg-background/50">
        <div className="container px-4 md:px-6">
          <ScrollReveal direction="up">
            <h2 className="text-3xl font-bold tracking-tight sm:text-4xl md:text-5xl text-center mb-12">
              Why Choose <GradientText>Shorted</GradientText>?
            </h2>
          </ScrollReveal>

          <div className="grid gap-8 md:grid-cols-3 max-w-5xl mx-auto">
            <ScrollReveal direction="left" delay={0}>
              <div className="text-center p-6">
                <div className="mb-4 p-4 rounded-full bg-blue-500/10 w-fit mx-auto">
                  <Zap className="h-8 w-8 text-blue-500" />
                </div>
                <h3 className="text-xl font-semibold mb-2">Lightning Fast</h3>
                <p className="text-muted-foreground">
                  Get insights faster with our optimized data pipeline and
                  real-time updates.
                </p>
              </div>
            </ScrollReveal>

            <ScrollReveal direction="up" delay={100}>
              <div className="text-center p-6">
                <div className="mb-4 p-4 rounded-full bg-purple-500/10 w-fit mx-auto">
                  <Shield className="h-8 w-8 text-purple-500" />
                </div>
                <h3 className="text-xl font-semibold mb-2">Reliable Data</h3>
                <p className="text-muted-foreground">
                  Sourced directly from ASIC regulatory filings for the most
                  accurate information.
                </p>
              </div>
            </ScrollReveal>

            <ScrollReveal direction="right" delay={200}>
              <div className="text-center p-6">
                <div className="mb-4 p-4 rounded-full bg-pink-500/10 w-fit mx-auto">
                  <Clock className="h-8 w-8 text-pink-500" />
                </div>
                <h3 className="text-xl font-semibold mb-2">Always Updated</h3>
                <p className="text-muted-foreground">
                  Daily syncs ensure you always have the latest short position
                  data.
                </p>
              </div>
            </ScrollReveal>
          </div>
        </div>
      </section>

      {/* Data Showcase Section */}
      <section className="w-full py-16 md:py-24 relative z-10">
        <div className="container px-4 md:px-6">
          <ScrollReveal direction="up">
            <div className="max-w-4xl mx-auto text-center mb-12">
              <h2 className="text-3xl font-bold tracking-tight sm:text-4xl md:text-5xl mb-4">
                Comprehensive <GradientText>Market Data</GradientText>
              </h2>
              <p className="text-lg text-muted-foreground">
                Track short positions across all ASX-listed companies with
                detailed analytics and visualizations
              </p>
            </div>
          </ScrollReveal>

          <ScrollReveal direction="up" delay={200}>
            <div className="grid gap-6 md:grid-cols-3 max-w-5xl mx-auto">
              <SpotlightCard>
                <div className="flex items-center gap-4">
                  <div className="p-3 rounded-lg bg-blue-500/10">
                    <Database className="h-6 w-6 text-blue-500" />
                  </div>
                  <div>
                    <div className="text-2xl font-bold">
                      {isLoadingStats ? (
                        <span className="animate-pulse">...</span>
                      ) : statistics ? (
                        `${statistics.companyCount}+`
                      ) : (
                        "..."
                      )}
                    </div>
                    <div className="text-sm text-muted-foreground">
                      Companies
                    </div>
                  </div>
                </div>
              </SpotlightCard>

              <SpotlightCard>
                <div className="flex items-center gap-4">
                  <div className="p-3 rounded-lg bg-purple-500/10">
                    <BarChart2 className="h-6 w-6 text-purple-500" />
                  </div>
                  <div>
                    <div className="text-2xl font-bold">
                      {isLoadingStats ? (
                        <span className="animate-pulse">...</span>
                      ) : statistics ? (
                        `${statistics.industryCount}+`
                      ) : (
                        "..."
                      )}
                    </div>
                    <div className="text-sm text-muted-foreground">
                      Industries
                    </div>
                  </div>
                </div>
              </SpotlightCard>

              <SpotlightCard>
                <div className="flex items-center gap-4">
                  <div className="p-3 rounded-lg bg-pink-500/10">
                    <TrendingDown className="h-6 w-6 text-pink-500" />
                  </div>
                  <div>
                    <div className="text-2xl font-bold">Daily</div>
                    <div className="text-sm text-muted-foreground">Updates</div>
                  </div>
                </div>
              </SpotlightCard>
            </div>
          </ScrollReveal>
        </div>
      </section>

      {/* CTA Section */}
      <section className="w-full py-16 md:py-24 lg:py-32 relative z-10 bg-gradient-to-br from-blue-500/10 via-purple-500/10 to-pink-500/10 backdrop-blur-sm">
        <div className="container px-4 md:px-6">
          <ScrollReveal direction="up">
            <div className="flex flex-col items-center space-y-6 text-center max-w-3xl mx-auto">
              <h2 className="text-3xl font-bold tracking-tight sm:text-4xl md:text-5xl">
                Ready to Discover{" "}
                <GradientText>Interesting Open Short Positions</GradientText>?
              </h2>
              <p className="mx-auto max-w-[600px] text-lg text-muted-foreground">
                We hope you find this tool useful for managing your short
                position investments. Start exploring today and gain deeper
                insights into market sentiment.
              </p>
              <div className="flex flex-col sm:flex-row gap-4 mt-8">
                <Link href="/">
                  <Button size="lg" className="text-lg px-8 py-6">
                    Get Started
                  </Button>
                </Link>
                <Link href="/stocks">
                  <Button
                    size="lg"
                    variant="outline"
                    className="text-lg px-8 py-6"
                  >
                    Browse Stocks
                  </Button>
                </Link>
              </div>
            </div>
          </ScrollReveal>
        </div>
      </section>
    </div>
  );
};

export default AboutClient;

"use client";

import React from "react";
import { GoogleAnalytics } from "@next/third-parties/google";
import { TopShorts } from "./topShortsView/topShorts";
import { IndustryTreeMapView } from "./treemap/treeMap";
import { ViewMode } from "~/gen/shorts/v1alpha1/shorts_pb";
import { LoginPromptBanner } from "~/@/components/ui/login-prompt-banner";
import { useSession } from "next-auth/react";
import { Button } from "~/@/components/ui/button";
import Link from "next/link";
import {
  ChevronDown,
  Activity,
  Zap,
  Search,
} from "lucide-react";

// Import marketing components
import { ScrollReveal } from "~/@/components/marketing/scroll-reveal";
import { AnimatedStockTicker } from "~/@/components/marketing/animated-stock-ticker";
import { BackgroundBeams } from "~/@/components/marketing/background-beams";

const Page = () => {
  const { data: session } = useSession();

  const scrollToDashboard = () => {
    const dashboardElement = document.getElementById("dashboard-view");
    if (dashboardElement) {
      dashboardElement.scrollIntoView({ behavior: "smooth" });
    }
  };

  return (
    <div className="min-h-screen flex flex-col relative bg-background overflow-x-hidden selection:bg-blue-500/30">
      <GoogleAnalytics gaId="G-X85RLQ4N2N" />
      
      {/* Subtle login prompt banner for non-authenticated users */}
      {!session && <div className="relative z-50"><LoginPromptBanner /></div>}

      {/* Hero Landing Section */}
      <section className="relative w-full min-h-screen flex flex-col items-center justify-center px-4 overflow-hidden">
        
        {/* Background Effects */}
        <BackgroundBeams className="z-0" />
        
        {/* Content */}
        <div className="container relative z-10 max-w-7xl mx-auto flex flex-col items-center pt-20 md:pt-0">
          <ScrollReveal direction="up" delay={0}>
            <div className="flex flex-col items-center space-y-10 text-center">
              
              {/* High-tech Badge */}
              <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-1.5 text-sm font-medium text-blue-200 backdrop-blur-md shadow-[0_0_20px_-10px_rgba(59,130,246,0.5)] hover:bg-white/10 transition-colors cursor-default">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500"></span>
                </span>
                Live ASX Short Position Intelligence
              </div>

              <div className="space-y-4 max-w-5xl">
                <h1 className="text-5xl md:text-7xl lg:text-8xl font-bold tracking-tighter bg-clip-text text-transparent bg-gradient-to-b from-white to-white/60">
                  See What The Market <br className="hidden md:block" />
                  <span className="text-blue-500 inline-block relative">
                    Is Shorting
                    <svg className="absolute w-full h-3 -bottom-1 left-0 text-blue-500/50" viewBox="0 0 100 10" preserveAspectRatio="none">
                       <path d="M0 5 Q 50 10 100 5" stroke="currentColor" strokeWidth="3" fill="none" />
                    </svg>
                  </span>
                </h1>
              </div>
              
              <p className="mx-auto max-w-2xl text-lg md:text-xl text-muted-foreground/80 leading-relaxed tracking-wide">
                Advanced analytics for the Australian Securities Exchange. 
                Track short positions, identify trends, and gain the edge with institutional-grade data.
              </p>

              {/* Enhanced CTA Buttons */}
              <div className="flex flex-col sm:flex-row gap-5 w-full justify-center items-center mt-4">
                <Button 
                  size="lg" 
                  className="group relative overflow-hidden rounded-full bg-blue-600 hover:bg-blue-500 text-white px-8 py-6 text-lg transition-all duration-300 hover:shadow-[0_0_40px_-10px_rgba(59,130,246,0.8)] border-0"
                  onClick={scrollToDashboard}
                >
                  <span className="relative z-10 flex items-center gap-2">
                    <Activity className="h-5 w-5" />
                    Launch Dashboard
                  </span>
                  <div className="absolute inset-0 -translate-x-full group-hover:translate-x-0 bg-gradient-to-r from-transparent via-white/20 to-transparent transition-transform duration-700 ease-in-out" />
                </Button>

                <Link href="/stocks">
                  <Button 
                    size="lg" 
                    variant="outline" 
                    className="group rounded-full border-white/10 bg-white/5 hover:bg-white/10 backdrop-blur-sm px-8 py-6 text-lg text-foreground transition-all duration-300 hover:border-blue-500/50"
                  >
                     <span className="flex items-center gap-2">
                      <Search className="h-5 w-5 text-muted-foreground group-hover:text-blue-400 transition-colors" />
                      Search Stocks
                    </span>
                  </Button>
                </Link>
              </div>

              {/* Floating Stats / Ticker */}
              <div className="w-full max-w-4xl mt-20 border border-white/5 rounded-2xl bg-black/20 backdrop-blur-xl p-6 shadow-2xl relative overflow-hidden group hover:border-white/10 transition-colors">
                 <div className="absolute inset-0 bg-gradient-to-r from-blue-500/5 via-transparent to-purple-500/5 opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
                 <div className="relative z-10">
                    <div className="flex items-center justify-between mb-4 px-2">
                       <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground flex items-center gap-2">
                         <Zap className="h-3 w-3 text-yellow-500" /> Trending Shorts
                       </span>
                       <span className="text-xs text-muted-foreground/50">Real-time updates</span>
                    </div>
                    <AnimatedStockTicker />
                 </div>
              </div>

            </div>
          </ScrollReveal>
        </div>
        
        {/* Scroll Indicator */}
        <div 
          className="absolute bottom-8 left-1/2 transform -translate-x-1/2 cursor-pointer animate-bounce"
          onClick={scrollToDashboard}
        >
          <div className="flex flex-col items-center gap-2 opacity-50 hover:opacity-100 transition-opacity">
            <span className="text-[10px] uppercase tracking-widest">Scroll</span>
            <ChevronDown className="h-5 w-5" />
          </div>
        </div>
      </section>

      {/* Dashboard Section */}
      <div id="dashboard-view" className="relative z-10 w-full bg-background min-h-screen border-t border-white/5">
        {/* Decorative gradient for section separation */}
        <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-blue-500/50 to-transparent" />
        
        <div className="container mx-auto px-4 py-20">
          <ScrollReveal direction="up">
            <div className="flex flex-col md:flex-row justify-between items-end mb-12 gap-4">
              <div className="space-y-2">
                <h2 className="text-3xl md:text-4xl font-bold tracking-tight">Market Intelligence</h2>
                <p className="text-muted-foreground max-w-lg">
                  Comprehensive breakdown of short positions across industries and individual stocks.
                </p>
              </div>
            </div>
          </ScrollReveal>

          <div className="flex flex-col xl:flex-row gap-8">
            {/* Top Shorts Panel */}
            <div className="xl:w-[40%] flex flex-col">
               <div className="rounded-2xl border border-white/10 bg-card/50 backdrop-blur-sm shadow-lg overflow-hidden flex-grow hover:border-blue-500/30 transition-colors duration-300">
                 <div className="p-1 h-full relative">
                    {/* Subtle internal glow */}
                    <div className="absolute -top-20 -right-20 w-60 h-60 bg-blue-500/10 blur-[80px] pointer-events-none" />
                    <TopShorts 
                      initialPeriod="3m" 
                      className="border-none bg-transparent shadow-none m-0"
                    />
                 </div>
               </div>
            </div>
            
            {/* Tree Map Panel */}
            <div className="xl:w-[60%] flex flex-col">
              <div className="rounded-2xl border border-white/10 bg-card/50 backdrop-blur-sm shadow-lg overflow-hidden flex-grow hover:border-purple-500/30 transition-colors duration-300 min-h-[600px]">
                 <div className="p-1 h-full relative">
                    {/* Subtle internal glow */}
                    <div className="absolute -bottom-20 -left-20 w-60 h-60 bg-purple-500/10 blur-[80px] pointer-events-none" />
                    <IndustryTreeMapView
                      initialPeriod="3m"
                      initialViewMode={ViewMode.CURRENT_CHANGE}
                      className="border-none bg-transparent shadow-none m-0"
                    />
                 </div>
              </div>
            </div>
          </div>
        </div>
      </div>

    </div>
  );
};

export default Page;

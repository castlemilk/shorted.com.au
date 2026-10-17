"use client";

import dynamic from "next/dynamic";

// Optional animation islands stay in their own chunks. Article figures are
// server-rendered and do not import this module or its animation runtime.
export const ScrollReveal = dynamic(() => import("~/@/components/marketing/scroll-reveal").then((m) => m.ScrollReveal));
export const CountUp = dynamic(() => import("~/@/components/marketing/count-up").then((m) => m.CountUp));

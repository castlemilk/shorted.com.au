"use client";

import { useEffect } from "react";

export function WebVitalsReporter() {
  useEffect(() => {
    // Only report in production
    if (process.env.NODE_ENV !== "production") return;

    void import("~/@/lib/web-vitals").then(({ reportWebVitals }) => {
      void reportWebVitals();
    });
  }, []);

  return null;
}

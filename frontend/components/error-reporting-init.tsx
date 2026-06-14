"use client";

import { useEffect } from "react";
import { initErrorReporting } from "@/lib/error-reporting";

// Branche les handlers globaux (error / unhandledrejection) au montage, côté
// client. Rendu une fois dans le RootLayout. N'affiche rien.
export function ErrorReportingInit() {
  useEffect(() => {
    initErrorReporting();
  }, []);
  return null;
}

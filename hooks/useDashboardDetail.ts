"use client";
import { useState } from "react";

// Which dashboard KPI card (if any) is currently expanded inline. Generic over each app's own
// kind union since VaultApp and GrApp have different card sets.
export function useDashboardDetail<K extends string>() {
  const [dashboardDetail, setDashboardDetail] = useState<K | null>(null);
  const toggleDashboardDetail = (kind: K) =>
    setDashboardDetail((current) => (current === kind ? null : kind));
  return { dashboardDetail, setDashboardDetail, toggleDashboardDetail };
}

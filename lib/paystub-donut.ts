import type { DonutSegment } from "@/components/DonutChart";

// Extracted out of components/reports/TaxReport.tsx (a "use client" component file, too heavy to
// pull into a plain Node test) so this pure function is unit-testable -- same "extracted for
// shared/testable" precedent as lib/plaid-classify.ts's isCashBankGroup.
//
// Fixed color per component (not palette-cycled) so a given slice means the same thing across
// every paystub you open -- comparing periods side by side relies on Federal always being red,
// Net always being green, etc. Take-home defaults to the REMAINDER (gross minus every other
// slice) when no authoritative `net` is passed in -- this app has more than one "Net" concept on
// a paystub (e.g. "Net Salary" is gross minus tax only, before 401K/medical/ESPP; "After Tax
// Salary" is the true final take-home), and picking the wrong stored figure would silently
// produce slices that don't sum to gross.
// BUT the remainder is only as good as the itemized categories being exhaustive, which a real
// paystub isn't guaranteed to be -- confirmed live, an NVIDIA "RSU Excess Tax" credit line (a
// refund of previously over-withheld RSU tax) has no bucket here at all, so the remainder
// silently dropped it and understated Net Take-Home by exactly that amount versus the PDF's own
// printed Net Pay. When `net` IS passed (an uploaded PDF's own independently-parsed "Net Pay"
// line, see lib/parse-paystub-pdf.ts), it wins as Net Take-Home, and any gap between it and the
// itemized remainder shows up as its own explicit "Other" slice instead of vanishing.
export function paystubDonutSegments({
  gross, federal, ssn, medicare, state, k401, medical, espp, net,
}: {
  gross: number; federal: number; ssn: number; medicare: number; state: number; k401: number; medical: number; espp: number; net?: number;
}): DonutSegment[] {
  const otherSlices = Math.max(0, federal) + Math.max(0, ssn) + Math.max(0, medicare) + Math.max(0, state) + Math.max(0, k401) + Math.max(0, medical) + Math.max(0, espp);
  const remainderNet = Math.max(0, gross - otherSlices);
  const takeHome = net ?? remainderNet;
  const unaccounted = net != null ? net - remainderNet : 0;
  const segments: DonutSegment[] = [
    { label: "Net Take-Home", value: Math.max(0, takeHome), color: "#16a34a" },
    { label: "Federal Tax", value: Math.max(0, federal), color: "#dc2626" },
    { label: "SSN + Medicare", value: Math.max(0, ssn + medicare), color: "#d97706" },
    { label: "State Tax", value: Math.max(0, state), color: "#7c3aed" },
    { label: "401K", value: Math.max(0, k401), color: "#0891b2" },
    { label: "Medical", value: Math.max(0, medical), color: "#0d9488" },
    { label: "ESPP", value: Math.max(0, espp), color: "#db2777" },
  ];
  if (Math.abs(unaccounted) > 0.01) {
    segments.push({ label: unaccounted > 0 ? "Other (not itemized)" : "Other deduction", value: Math.abs(unaccounted), color: "#64748b" });
  }
  return segments;
}

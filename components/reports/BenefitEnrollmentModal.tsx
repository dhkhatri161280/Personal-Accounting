"use client";
import { useMemo, useRef, useState } from "react";
import { FloatingWindow as Modal } from "@/components/FloatingWindow";
import type { BenefitEnrollmentYear, BenefitEnrollmentCategory, VaultDocument } from "@/lib/vault-types";
import {
  DEFAULT_PAY_PERIODS_PER_YEAR,
  mergeBenefitEnrollmentYear,
  removeBenefitEnrollmentYear,
  costPerMonth,
  costPerYear,
} from "@/lib/benefit-enrollment";

// A short starting set for the manual-entry fallback (a scanned/image PDF with no extractable
// text) -- the handful of categories that usually actually cost something; "+ Add row" covers
// anything else (an employer-paid $0 line the user doesn't care to track isn't worth prefilling).
const MANUAL_ENTRY_DEFAULTS = ["Medical", "Dental", "Vision", "Legal Services", "Short Term Disability"];

type DraftCategory = { category: string; planName: string; costPerPayPeriod: string };

function draftFrom(categories: BenefitEnrollmentCategory[]): DraftCategory[] {
  return categories.map((c) => ({ category: c.category, planName: c.planName, costPerPayPeriod: String(c.costPerPayPeriod) }));
}

export function BenefitEnrollmentModal({
  years,
  onSave,
  archiveDocument,
  onClose,
  fmt,
}: {
  years: BenefitEnrollmentYear[];
  onSave: (years: BenefitEnrollmentYear[], newDocument?: VaultDocument) => Promise<boolean | void>;
  // Obvious, same as every other upload in this app: the PDF itself gets archived into
  // Masters > Documents (category "Benefit Enrollment"), not just read-and-discarded. Takes an
  // error setter instead of throwing -- archival failing is a soft warning, not a blocker; the
  // numeric save it rides alongside is the part that actually matters.
  archiveDocument: (file: File, label: string, date: string, setError: (msg: string) => void) => Promise<VaultDocument | null>;
  onClose: () => void;
  fmt: (n: number) => string;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState("");
  const [saving, setSaving] = useState(false);

  // The staged "review before save" record -- never written until the user clicks Save, same
  // pattern as TaxReport's own paystubReview.
  const [draft, setDraft] = useState<{
    year: string;
    asOfDate: string;
    totalCostPerPayPeriod: string;
    payPeriodsPerYear: string;
    categories: DraftCategory[];
    source: "parsed" | "manual";
    warnings: string[];
    // Carried along even when parsing fails (a scanned-image PDF, say) -- entering the numbers by
    // hand doesn't mean the original PDF shouldn't still be archived into Documents.
    file: File | null;
  } | null>(null);

  const [selectedYears, setSelectedYears] = useState<Set<number>>(() => new Set(years.slice(0, 2).map((y) => y.year)));

  function startManualEntry(file: File | null = null) {
    setParseError("");
    const thisYear = new Date().getFullYear();
    setDraft({
      year: String(thisYear),
      asOfDate: "",
      totalCostPerPayPeriod: "",
      payPeriodsPerYear: String(DEFAULT_PAY_PERIODS_PER_YEAR),
      categories: MANUAL_ENTRY_DEFAULTS.map((category) => ({ category, planName: "", costPerPayPeriod: "0" })),
      source: "manual",
      warnings: [],
      file,
    });
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setParseError("");
    setParsing(true);
    try {
      const { parseBenefitEnrollmentPdf } = await import("@/lib/parse-benefit-enrollment-pdf");
      const parsed = await parseBenefitEnrollmentPdf(file);
      const inferredYear = parsed.asOfDate ? Number(parsed.asOfDate.slice(0, 4)) : new Date().getFullYear();
      setDraft({
        year: String(inferredYear),
        asOfDate: parsed.asOfDate,
        totalCostPerPayPeriod: String(parsed.totalCostPerPayPeriod),
        payPeriodsPerYear: String(DEFAULT_PAY_PERIODS_PER_YEAR),
        categories: draftFrom(parsed.categories),
        source: "parsed",
        warnings: parsed.warnings,
        file,
      });
    } catch (err) {
      // Exactly the "no extractable text" / "doesn't look like a statement" cases
      // parseBenefitEnrollmentPdf throws for -- fall straight into manual entry instead of a dead
      // end, with the file still attached (so it still gets archived once saved) and the real
      // parse error shown as the form's own warning, not a separate banner the user has to notice.
      const message = err instanceof Error ? err.message : "Couldn't read that PDF.";
      startManualEntry(file);
      setDraft((d) => (d ? { ...d, warnings: [message, ...d.warnings] } : d));
    } finally {
      setParsing(false);
    }
  }

  function updateCategory(i: number, patch: Partial<DraftCategory>) {
    setDraft((d) => (d ? { ...d, categories: d.categories.map((c, ci) => (ci === i ? { ...c, ...patch } : c)) } : d));
  }
  function removeCategory(i: number) {
    setDraft((d) => (d ? { ...d, categories: d.categories.filter((_, ci) => ci !== i) } : d));
  }
  function addCategory() {
    setDraft((d) => (d ? { ...d, categories: [...d.categories, { category: "", planName: "", costPerPayPeriod: "0" }] } : d));
  }

  const draftCategorySum = useMemo(
    () => (draft ? draft.categories.reduce((s, c) => s + (Number(c.costPerPayPeriod) || 0), 0) : 0),
    [draft]
  );

  async function saveDraft() {
    if (!draft) return;
    setParseError("");
    const year = Number(draft.year);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      setParseError("Enter a valid 4-digit year.");
      return;
    }
    const record: BenefitEnrollmentYear = {
      year,
      asOfDate: draft.asOfDate || undefined,
      payPeriodsPerYear: Number(draft.payPeriodsPerYear) || DEFAULT_PAY_PERIODS_PER_YEAR,
      totalCostPerPayPeriod: Number(draft.totalCostPerPayPeriod) || draftCategorySum,
      categories: draft.categories
        .filter((c) => c.category.trim())
        .map((c) => ({ category: c.category.trim(), planName: c.planName.trim() || "—", costPerPayPeriod: Number(c.costPerPayPeriod) || 0 })),
      uploadedAt: new Date().toISOString(),
      source: draft.source,
    };
    setSaving(true);
    try {
      // Archive the original PDF into Masters > Documents FIRST, same "one upload does both
      // jobs" pattern as the paystub flow -- a soft failure here (reported via setParseError, not
      // thrown) still lets the numeric save below go through; the numbers are the part that
      // actually matters, the archive is a convenience on top.
      const newDocument = draft.file
        ? (await archiveDocument(draft.file, `Benefit Enrollment — ${year}`, draft.asOfDate || `${year}-01-01`, setParseError)) ?? undefined
        : undefined;
      const merged = mergeBenefitEnrollmentYear(years, record);
      const ok = await onSave(merged, newDocument);
      if (ok !== false) {
        setDraft(null);
        setSelectedYears((prev) => new Set([...prev, record.year]));
      }
    } finally {
      setSaving(false);
    }
  }

  async function deleteYear(year: number) {
    if (!confirm(`Remove the ${year} benefit enrollment record? This only removes it from this app, not anywhere else.`)) return;
    await onSave(removeBenefitEnrollmentYear(years, year));
    setSelectedYears((prev) => {
      const next = new Set(prev);
      next.delete(year);
      return next;
    });
  }

  const sortedYears = useMemo(() => [...years].sort((a, b) => b.year - a.year), [years]);
  const compareYears = useMemo(
    () => sortedYears.filter((y) => selectedYears.has(y.year)).sort((a, b) => a.year - b.year),
    [sortedYears, selectedYears]
  );
  const [showAllCategories, setShowAllCategories] = useState(false);
  // Union of every category name across the selected years, in first-seen order -- a category
  // enrolled one year but dropped (or newly added) the next still gets its own row, reading as
  // "—" for the year it didn't appear in rather than being silently left out of the comparison.
  // Every saved year still keeps its full category list (including $0/Waived) regardless -- this
  // only trims what the COMPARISON shows, since a dozen+ always-$0 rows (HSA, Accident Insurance,
  // every Critical Illness/AD&D variant, ...) just buries the handful that actually cost money
  // and are worth comparing. "Show all categories" below opts back into the full list.
  const allCategoryNames = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const y of compareYears) for (const c of y.categories) if (!seen.has(c.category)) { seen.add(c.category); out.push(c.category); }
    if (showAllCategories) return out;
    return out.filter((name) => compareYears.some((y) => (y.categories.find((c) => c.category === name)?.costPerPayPeriod ?? 0) !== 0));
  }, [compareYears, showAllCategories]);

  function toggleYear(year: number) {
    setSelectedYears((prev) => {
      const next = new Set(prev);
      if (next.has(year)) next.delete(year);
      else next.add(year);
      return next;
    });
  }

  return (
    <Modal title="Benefit Enrollment Cost" onClose={onClose} wide>
      <div style={{ padding: "0 4px" }}>
        {!draft && (
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
            <input ref={fileInputRef} type="file" accept=".pdf" style={{ display: "none" }} onChange={handleUpload} />
            <button className="equity-refresh" onClick={() => fileInputRef.current?.click()} disabled={parsing}>
              {parsing ? "Reading…" : "📄 Upload Enrollment PDF"}
            </button>
            <button className="equity-refresh" onClick={() => startManualEntry()} disabled={parsing}>
              ✏️ Enter Manually
            </button>
          </div>
        )}
        {parseError && <p style={{ color: "#dc2626", fontSize: 13, marginBottom: 12 }}>{parseError}</p>}

        {draft && (
          <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 12, marginBottom: 16 }}>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 10 }}>
              <label style={{ display: "flex", flexDirection: "column", fontSize: 12 }}>
                Year
                <input value={draft.year} onChange={(e) => setDraft({ ...draft, year: e.target.value })} style={{ width: 90 }} />
              </label>
              <label style={{ display: "flex", flexDirection: "column", fontSize: 12 }}>
                Total cost / pay period
                <input
                  value={draft.totalCostPerPayPeriod}
                  onChange={(e) => setDraft({ ...draft, totalCostPerPayPeriod: e.target.value })}
                  style={{ width: 110 }}
                />
              </label>
              <label style={{ display: "flex", flexDirection: "column", fontSize: 12 }}>
                Pay periods / year
                <input
                  value={draft.payPeriodsPerYear}
                  onChange={(e) => setDraft({ ...draft, payPeriodsPerYear: e.target.value })}
                  style={{ width: 90 }}
                />
              </label>
              {draft.source === "parsed" && (
                <span style={{ alignSelf: "flex-end", fontSize: 11, opacity: 0.6, paddingBottom: 4 }}>
                  Parsed from PDF — review before saving
                </span>
              )}
            </div>
            {draft.warnings.length > 0 && (
              <p style={{ fontSize: 12, color: "#b45309", marginBottom: 8 }}>{draft.warnings.join(" ")}</p>
            )}
            {Math.abs(draftCategorySum - (Number(draft.totalCostPerPayPeriod) || 0)) > 0.5 && (
              <p style={{ fontSize: 12, color: "#b45309", marginBottom: 8 }}>
                Categories sum to {fmt(draftCategorySum)}, which doesn&apos;t match the total above ({fmt(Number(draft.totalCostPerPayPeriod) || 0)}) — check for a missed row.
              </p>
            )}
            <table className="fx-ledger-table" style={{ marginBottom: 8 }}>
              <thead>
                <tr>
                  <th>Category</th>
                  <th>Enrolled in</th>
                  <th className="right">Cost / pay period</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {draft.categories.map((c, i) => (
                  <tr key={i}>
                    <td>
                      <input
                        value={c.category}
                        onChange={(e) => updateCategory(i, { category: e.target.value })}
                        style={{ width: "100%" }}
                      />
                    </td>
                    <td>
                      <input
                        value={c.planName}
                        onChange={(e) => updateCategory(i, { planName: e.target.value })}
                        style={{ width: "100%" }}
                      />
                    </td>
                    <td className="right">
                      <input
                        value={c.costPerPayPeriod}
                        onChange={(e) => updateCategory(i, { costPerPayPeriod: e.target.value })}
                        style={{ width: 90, textAlign: "right" }}
                      />
                    </td>
                    <td>
                      <button type="button" className="master-delete" onClick={() => removeCategory(i)}>
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" className="tr-refresh-btn" onClick={addCategory}>
                + Add row
              </button>
              <span style={{ flex: 1 }} />
              <button type="button" className="tr-refresh-btn" onClick={() => setDraft(null)} disabled={saving}>
                Cancel
              </button>
              <button type="button" className="equity-refresh" onClick={saveDraft} disabled={saving}>
                {saving ? "Saving…" : `Save ${draft.year}`}
              </button>
            </div>
          </div>
        )}

        {sortedYears.length === 0 ? (
          <p style={{ opacity: 0.7, fontSize: 13 }}>
            No benefit enrollment years saved yet. Upload this year&apos;s confirmation PDF (or enter it manually) above.
          </p>
        ) : (
          <>
            <h4 style={{ margin: "0 0 8px" }}>Saved years</h4>
            <table className="fx-ledger-table" style={{ marginBottom: 16 }}>
              <thead>
                <tr>
                  <th></th>
                  <th>Year</th>
                  <th className="right">Cost / pay period</th>
                  <th className="right">Cost / month</th>
                  <th className="right">Cost / year</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {sortedYears.map((y) => (
                  <tr key={y.year}>
                    <td>
                      <input type="checkbox" checked={selectedYears.has(y.year)} onChange={() => toggleYear(y.year)} />
                    </td>
                    <td>{y.year}</td>
                    <td className="right">{fmt(y.totalCostPerPayPeriod)}</td>
                    <td className="right">{fmt(costPerMonth(y, y.totalCostPerPayPeriod))}</td>
                    <td className="right">{fmt(costPerYear(y, y.totalCostPerPayPeriod))}</td>
                    <td>
                      <button type="button" className="master-delete" onClick={() => deleteYear(y.year)}>
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {compareYears.length >= 2 ? (
              <>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8, flexWrap: "wrap", gap: 8 }}>
                  <h4 style={{ margin: 0 }}>Comparison — {compareYears.map((y) => y.year).join(" vs ")}</h4>
                  <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, opacity: 0.75, cursor: "pointer" }}>
                    <input type="checkbox" checked={showAllCategories} onChange={(e) => setShowAllCategories(e.target.checked)} />
                    Show all categories (including $0 / Waived)
                  </label>
                </div>
                <table className="fx-ledger-table">
                  <thead>
                    <tr>
                      <th>Category</th>
                      {compareYears.map((y) => (
                        <th key={y.year} className="right">
                          {y.year}
                          <div style={{ fontWeight: 400, fontSize: 10, opacity: 0.6 }}>per pay / mo / yr</div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {allCategoryNames.map((name) => (
                      <tr key={name}>
                        <td>{name}</td>
                        {compareYears.map((y) => {
                          const cat = y.categories.find((c) => c.category === name);
                          if (!cat) return <td key={y.year} className="right" style={{ opacity: 0.4 }}>—</td>;
                          return (
                            <td key={y.year} className="right">
                              <div>{fmt(cat.costPerPayPeriod)}</div>
                              <div style={{ fontSize: 11, opacity: 0.65 }}>
                                {fmt(costPerMonth(y, cat.costPerPayPeriod))} / {fmt(costPerYear(y, cat.costPerPayPeriod))}
                              </div>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                    <tr style={{ fontWeight: 700 }}>
                      <td>Total</td>
                      {compareYears.map((y) => (
                        <td key={y.year} className="right">
                          <div>{fmt(y.totalCostPerPayPeriod)}</div>
                          <div style={{ fontSize: 11, opacity: 0.65, fontWeight: 400 }}>
                            {fmt(costPerMonth(y, y.totalCostPerPayPeriod))} / {fmt(costPerYear(y, y.totalCostPerPayPeriod))}
                          </div>
                        </td>
                      ))}
                    </tr>
                    {compareYears.length === 2 && (
                      <tr>
                        <td style={{ opacity: 0.7 }}>Change (per pay period)</td>
                        <td></td>
                        <td className="right" style={{ color: compareYears[1].totalCostPerPayPeriod >= compareYears[0].totalCostPerPayPeriod ? "#dc2626" : "#16a34a" }}>
                          {compareYears[1].totalCostPerPayPeriod >= compareYears[0].totalCostPerPayPeriod ? "+" : ""}
                          {fmt(compareYears[1].totalCostPerPayPeriod - compareYears[0].totalCostPerPayPeriod)}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </>
            ) : (
              <p style={{ opacity: 0.7, fontSize: 13 }}>Check 2 or more years above to compare them side by side.</p>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

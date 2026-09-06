import type { AuditEntry } from "./vault-types";

const MAX_ENTRIES = 5000;

// Shallow field-level diff -- only the fields the caller cares about, and only the ones that
// actually changed. `before` undefined means "created" (nothing to compare against, everything
// in `after` is new).
export function diffFields<T extends Record<string, unknown>>(
  before: T | undefined,
  after: T,
  fields: (keyof T & string)[]
): { field: string; before: unknown; after: unknown }[] {
  const changes: { field: string; before: unknown; after: unknown }[] = [];
  for (const field of fields) {
    const b = before?.[field];
    const a = after[field];
    const same = JSON.stringify(b) === JSON.stringify(a);
    if (!same) changes.push({ field, before: b, after: a });
  }
  return changes;
}

function formatValue(v: unknown): string {
  if (v === undefined || v === null || v === "") return "(blank)";
  if (typeof v === "number") return v.toFixed(2);
  if (Array.isArray(v)) return `${v.length} entr${v.length === 1 ? "y" : "ies"}`;
  return String(v);
}

// One human-readable line summarizing a set of field changes, e.g. "Amount changed from $100.00
// to $150.00; Narration changed from 'Groceries' to 'Costco run'". Falls back to a generic line
// when there's nothing to compare (a plain create) or nothing changed.
export function summarize(changes: { field: string; before: unknown; after: unknown }[], createdLabel?: string): string {
  if (createdLabel) return createdLabel;
  if (!changes.length) return "No field changes.";
  return changes.map((c) => `${c.field} changed from ${formatValue(c.before)} to ${formatValue(c.after)}`).join("; ");
}

// Appends one entry and trims the oldest beyond MAX_ENTRIES -- returns a new object (spread,
// same "replace one field" pattern used everywhere else in this app), never mutates in place.
// Generic over any object with an optional auditLog array -- both the full Ledger and
// MastersPanel's slimmed-down MasterLedger prop type shape have one.
export function appendAuditEntry<T extends { auditLog?: AuditEntry[] }>(ledger: T, entry: Omit<AuditEntry, "id" | "at">): T {
  const full: AuditEntry = { ...entry, id: crypto.randomUUID(), at: new Date().toISOString() };
  const next = [...(ledger.auditLog ?? []), full];
  const trimmed = next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next;
  return { ...ledger, auditLog: trimmed };
}

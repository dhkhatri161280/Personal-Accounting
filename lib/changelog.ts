// Short, manually-maintained list of what shipped recently -- surfaced by clicking the header's
// BuildStamp, so "what changed" is answerable in-app instead of only via git log. Most recent
// entry first; keep entries to one line each. Not meant to be exhaustive -- just enough to jog
// memory about the last several real, user-facing changes.
export const CHANGELOG: { date: string; summary: string }[] = [
  { date: "2026-09-22", summary: "Fixed a Schwab re-auth alert that fired permanently due to a bad threshold" },
  { date: "2026-09-22", summary: "Attach a receipt photo while composing a New Voucher, not just after saving" },
  { date: "2026-09-22", summary: "Needs Attention now flags a broken Plaid connection or an expiring Schwab login" },
  { date: "2026-09-22", summary: "Header now shows the real live build instead of a manually-typed version string" },
  { date: "2026-09-22", summary: "New Voucher: keyboard-first entry, frequent-ledger chips, same-as-last, narration suggestions" },
  { date: "2026-09-22", summary: "Closed-period save errors now name the actual voucher instead of a generic count" },
  { date: "2026-09-21", summary: "Needs Attention flags a stuck or errored Tally sync; lock icon shows last-synced time" },
  { date: "2026-09-21", summary: "Fixed the Tally master-sync 401 introduced by the access-code security rollout" },
];

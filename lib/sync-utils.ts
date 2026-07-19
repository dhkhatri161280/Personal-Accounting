import type { Ledger, SyncHealth, Tx, Account } from "@/lib/vault-types";
import type { MasterGroup } from "@/components/MastersPanel";

export function syncNorm(value: unknown): string {
  return String(value ?? "")
    .replace(/&apos;|&#39;|&#x27;/gi, "'")
    .replace(/&quot;|&#34;|&#x22;/gi, '"')
    .replace(/&amp;/gi, "&")
    .trim()
    .toLowerCase();
}

// Parse string representation to avoid IEEE-754 float-multiply drift.
export function syncCents(value: unknown): number {
  const str = String(value ?? "0").trim().replace(/[^0-9.,-]/g, "");
  const negative = str.startsWith("-");
  const [wholePart = "0", fracPart = ""] = str.replace("-", "").split(".");
  const cents = Math.abs(Number(wholePart)) * 100 + Number((fracPart + "00").slice(0, 2));
  return negative ? -cents : cents;
}

// Normalise dates to ISO YYYY-MM-DD regardless of source format (Tally uses DD-MM-YYYY).
function normDate(date: string): string {
  const dmy = date.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
  return date;
}

export function voucherSyncFingerprint(t: Tx): string {
  // Voucher number is intentionally excluded — Tally auto-renumbers by date+type
  // when earlier-dated vouchers are inserted, making the number unstable.
  return JSON.stringify([
    normDate(t.date),
    syncNorm(t.type),
    syncNorm(t.narration),
    (t.entries || [])
      .map((e) => [syncNorm(e.accountName), syncCents(e.amount)])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  ]);
}

export function isVoucherSyncError(t: Tx): boolean {
  return /error|conflict/i.test(String(t.syncStatus || ""));
}

export function isVoucherPendingSync(t: Tx): boolean {
  if (isVoucherSyncError(t)) return false;
  const status = String(t.syncStatus || "").toLowerCase();
  const marker = String(t.syncFingerprint || "");
  if (status !== "pending") return false;
  if (marker.startsWith("app-change-")) return true;
  if (t.deleted) return Boolean(t.tallyGuid || marker);
  return false;
}

export function isMasterSyncError(m: Account | MasterGroup): boolean {
  return /error|conflict/i.test(
    String(
      (m as Account).masterSyncStatus ||
        (m as MasterGroup & { syncStatus?: string }).syncStatus ||
        ""
    )
  );
}

export function isMasterPendingSync(m: Account | MasterGroup): boolean {
  if (!m || isMasterSyncError(m)) return false;
  const marker = String((m as Account).masterFingerprint || "");
  return Boolean((m as Account).masterDeletePending || marker.startsWith("app-change-"));
}

export type SyncTone = "success" | "pending" | "error";
export type SyncState = { tone: SyncTone; label: string };

export function getSyncState(
  data: Ledger | null,
  _book: "us" | "india",
  health?: SyncHealth | null
): SyncState {
  const tx = data?.transactions || [],
    accounts = data?.accounts || [],
    groups: MasterGroup[] = (data as (Ledger & { groups?: MasterGroup[] }) | null)?.groups || [];
  const status = String(health?.status || "").toLowerCase();
  const hasRemote =
    !!health &&
    (!!health.lastCheckedAt ||
      status === "success" ||
      status === "pending" ||
      status === "running" ||
      status === "syncing" ||
      status === "error" ||
      Number.isFinite(Number(health.tallyToApp)) ||
      Number.isFinite(Number(health.appToTally)) ||
      Number.isFinite(Number(health.conflicts)) ||
      Number.isFinite(Number(health.errors)));

  if (hasRemote) {
    const tallyToApp = Number(health?.tallyToApp || 0),
      appToTally = Number(health?.appToTally || 0),
      conflicts = Number(health?.conflicts || 0),
      errors = Number(health?.errors || 0);
    const issueCount = errors + conflicts;
    const pendingCount = tallyToApp + appToTally;
    if (status === "error" || issueCount > 0)
      return {
        tone: "error",
        label:
          health?.message ||
          String(issueCount || 1) + " sync issue" + ((issueCount || 1) === 1 ? "" : "s"),
      };
    if (status === "pending" || status === "running" || status === "syncing" || pendingCount > 0)
      return {
        tone: "pending",
        label: health?.message || String(pendingCount || 1) + " pending sync",
      };
    return { tone: "success", label: health?.message || "Sync successful" };
  }

  const localErrors =
    tx.filter(isVoucherSyncError).length +
    accounts.filter(isMasterSyncError).length +
    groups.filter(isMasterSyncError).length;
  const localPending =
    tx.filter(isVoucherPendingSync).length +
    accounts.filter(isMasterPendingSync).length +
    groups.filter(isMasterPendingSync).length;

  if (localErrors)
    return {
      tone: "error",
      label: String(localErrors) + " sync error" + (localErrors === 1 ? "" : "s"),
    };
  if (localPending)
    return {
      tone: "pending",
      label: String(localPending) + " item" + (localPending === 1 ? "" : "s") + " pending sync",
    };
  return { tone: "success", label: "Sync successful" };
}

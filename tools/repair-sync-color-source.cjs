const fs = require("fs");
const path = require("path");

const file = path.join(process.cwd(), "components", "VaultApp.tsx");
let s = fs.readFileSync(file, "utf8");

const backup = `${file}.backup-clean-sync-color-${new Date().toISOString().replace(/[:.]/g, "-")}`;
fs.writeFileSync(backup, s);

function findFunction(src, name) {
  const start = src.indexOf(`function ${name}`);
  if (start < 0) throw new Error(`Could not find function ${name}`);
  const open = src.indexOf("{", start);
  let depth = 0, quote = null, esc = false;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") { quote = c; continue; }
    if (c === "{") depth++;
    if (c === "}") {
      depth--;
      if (depth === 0) return { start, end: i + 1 };
    }
  }
  throw new Error(`Could not find end of function ${name}`);
}

const replacement = `
function getSyncState(data: any | null, book: "us" | "india" = "us", remoteSyncHealth?: any) {
  const n = (v: any) => Number.isFinite(Number(v)) ? Number(v) : 0;
  const status = String(remoteSyncHealth?.status || "").toLowerCase();
  const checkedAt = remoteSyncHealth?.lastCheckedAt ? Date.parse(remoteSyncHealth.lastCheckedAt) : NaN;
  const remoteFresh = !!status && Number.isFinite(checkedAt) && Date.now() - checkedAt < 10 * 60 * 1000;

  const tallyToApp = n(remoteSyncHealth?.tallyToApp);
  const appToTally = n(remoteSyncHealth?.appToTally);
  const conflicts = n(remoteSyncHealth?.conflicts);
  const errors = n(remoteSyncHealth?.errors);

  const rows = [
    ...((data?.transactions || []) as any[]),
    ...((data?.accounts || []) as any[]),
    ...(((data as any)?.groups || []) as any[]),
  ];

  const appPendingAfterRemote = rows.some((item) => {
    const st = String(item?.syncStatus || "").toLowerCase();
    const fp = String(item?.syncFingerprint || "");
    const m = fp.match(/^app-change-(\\d+)/);
    const changedAt = m ? Number(m[1]) : NaN;
    return (st === "pending" || st === "queued" || st === "syncing")
      && fp.startsWith("app-change-")
      && (!Number.isFinite(checkedAt) || (Number.isFinite(changedAt) && changedAt > checkedAt));
  });

  if (remoteFresh) {
    if (status === "error" || conflicts > 0 || errors > 0) {
      const count = conflicts + errors || 1;
      return { tone: "error", label: remoteSyncHealth?.message || String(count) + " sync issue" + (count === 1 ? "" : "s") };
    }
    if (status === "pending" || status === "running" || status === "in_progress" || tallyToApp > 0 || appToTally > 0 || appPendingAfterRemote) {
      const count = tallyToApp + appToTally || 1;
      return { tone: "pending", label: String(count) + " pending sync item" + (count === 1 ? "" : "s") };
    }
    if (status === "success") return { tone: "success", label: "Sync successful" };
  }

  const localErrors = rows.filter((item) => ["error", "failed"].includes(String(item?.syncStatus || "").toLowerCase())).length;
  const localPending = rows.filter((item) => ["pending", "queued", "syncing"].includes(String(item?.syncStatus || "").toLowerCase())).length;

  if (localErrors > 0) return { tone: "error", label: String(localErrors) + " sync issue" + (localErrors === 1 ? "" : "s") };
  if (localPending > 0) return { tone: "pending", label: String(localPending) + " pending sync item" + (localPending === 1 ? "" : "s") };
  if (status && !remoteFresh) return { tone: "pending", label: "Sync status stale" };
  return { tone: "success", label: "Sync successful" };
}
`.trim();

const fn = findFunction(s, "getSyncState");
s = s.slice(0, fn.start) + replacement + s.slice(fn.end);

s = s.replace(/getSyncState\(\s*data\s*,\s*book\s*\)/g, "getSyncState(data, book, remoteSyncHealth)");
s = s.replace(/getSyncState\(\s*data\s*\)/g, "getSyncState(data, book, remoteSyncHealth)");

if (!s.includes("remoteSyncHealth")) {
  throw new Error("remoteSyncHealth is missing. Do not deploy. Restore the clean sync-status source first.");
}

fs.writeFileSync(file, s);
console.log("Clean sync color source repair applied.");
console.log("Backup:", backup);
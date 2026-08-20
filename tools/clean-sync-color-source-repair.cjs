const fs = require("fs");
const path = require("path");

const root = process.cwd();
const tsxPath = path.join(root, "components", "VaultApp.tsx");
const routePath = path.join(root, "app", "api", "sync-status", "route.ts");

if (!fs.existsSync(tsxPath)) {
  throw new Error("Missing components/VaultApp.tsx. Run from personal-accounting-app.");
}
if (!fs.existsSync(routePath)) {
  throw new Error("Missing app/api/sync-status/route.ts. Stop here; API route must exist before UI color repair.");
}

let s = fs.readFileSync(tsxPath, "utf8");
fs.copyFileSync(tsxPath, `${tsxPath}.backup-clean-sync-color-${new Date().toISOString().replace(/[:.]/g, "-")}`);

function replaceFunction(source, name, replacement) {
  const start = source.indexOf(`function ${name}`);
  if (start < 0) throw new Error(`Could not find function ${name}`);
  const brace = source.indexOf("{", start);
  let depth = 0;
  for (let i = brace; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}") depth--;
    if (depth === 0) {
      return source.slice(0, start) + replacement + source.slice(i + 1);
    }
  }
  throw new Error(`Could not find end of function ${name}`);
}

const typeBlock = `
type RemoteSyncHealth = {
  book?: "us" | "india" | string;
  status?: "success" | "pending" | "error" | string;
  lastCheckedAt?: string | null;
  matched?: number;
  tallyToApp?: number;
  appToTally?: number;
  conflicts?: number;
  errors?: number;
  message?: string;
};
`;

if (!s.includes("type RemoteSyncHealth")) {
  s = s.replace(/type\s+Book\s*=\s*"us"\s*\|\s*"india";?/, (m) => `${m}\n${typeBlock}`);
}

const cleanGetSyncState = `function getSyncState(data: Ledger | null, book: "us" | "india" = "us", remote?: RemoteSyncHealth | null) {
  const now = Date.now();
  const remoteAt = remote?.lastCheckedAt ? Date.parse(remote.lastCheckedAt) : 0;
  const remoteFresh = Number.isFinite(remoteAt) && remoteAt > 0 && now - remoteAt < 15 * 60 * 1000;

  const remoteTallyToApp = Number(remote?.tallyToApp || 0);
  const remoteAppToTally = Number(remote?.appToTally || 0);
  const remoteConflicts = Number(remote?.conflicts || 0);
  const remoteErrors = Number(remote?.errors || 0);
  const remoteStatus = String(remote?.status || "").toLowerCase();

  if (remoteStatus === "error" || remoteErrors > 0 || remoteConflicts > 0) {
    return { tone: "error", label: remote?.message || "Sync issue" };
  }

  const items = [
    ...((data?.transactions || []) as any[]),
    ...(((data as any)?.accounts || []) as any[]),
    ...(((data as any)?.groups || []) as any[]),
  ];

  const latestLocalAppChange = items.reduce((latest, item) => {
    const fp = String(item?.syncFingerprint || "");
    const match = /^app-change-(\\d+)/.exec(fp);
    return match ? Math.max(latest, Number(match[1]) || 0) : latest;
  }, 0);

  const localErrors = items.filter((item) =>
    ["error", "failed", "conflict"].includes(String(item?.syncStatus || "").toLowerCase())
  ).length;

  if (localErrors > 0) {
    return { tone: "error", label: `${localErrors} sync issue${localErrors === 1 ? "" : "s"}` };
  }

  if (latestLocalAppChange > 0 && (!remoteAt || latestLocalAppChange > remoteAt)) {
    return { tone: "pending", label: "Sync pending" };
  }

  if (remoteStatus === "pending" || remoteTallyToApp > 0 || remoteAppToTally > 0) {
    const pending = remoteTallyToApp + remoteAppToTally;
    return { tone: "pending", label: pending ? `${pending} item${pending === 1 ? "" : "s"} pending sync` : "Sync pending" };
  }

  if (remoteFresh && remoteStatus === "success") {
    return { tone: "success", label: "Sync successful" };
  }

  if (!remoteFresh) {
    return { tone: "pending", label: "Waiting for latest sync status" };
  }

  return { tone: "success", label: "Sync successful" };
}`;

s = replaceFunction(s, "getSyncState", cleanGetSyncState);

if (!s.includes("remoteSyncHealth")) {
  throw new Error("VaultApp.tsx is missing remoteSyncHealth state/polling. Stop here and tell Codex.");
}

s = s.replace(
  /const\s+syncState\s*=\s*getSyncState\(\s*data\s*\)\s*;/,
  "const syncState = getSyncState(data, book, remoteSyncHealth);"
);

s = s.replace(
  /const\s+syncState\s*=\s*getSyncState\(\s*data\s*,\s*book\s*\)\s*;/,
  "const syncState = getSyncState(data, book, remoteSyncHealth);"
);

fs.writeFileSync(tsxPath, s, "utf8");
console.log("Clean sync color source repair applied.");
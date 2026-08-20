const fs = require("fs");
const path = require("path");

const tsxPath = path.join(process.cwd(), "components", "VaultApp.tsx");
if (!fs.existsSync(tsxPath)) {
  throw new Error("Run this from C:\\Users\\dikhatri\\Documents\\Codex\\personal-accounting-app");
}

let src = fs.readFileSync(tsxPath, "utf8");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
fs.copyFileSync(tsxPath, `${tsxPath}.backup-authoritative-sync-status-${stamp}`);

function findFunction(source, name) {
  const match = new RegExp(`function\\s+${name}\\s*\\(`).exec(source);
  if (!match) throw new Error(`Could not find function ${name}`);
  const open = source.indexOf("{", match.index);
  if (open < 0) throw new Error(`Could not find function body for ${name}`);

  let depth = 0;
  let quote = "";
  let escape = false;

  for (let i = open; i < source.length; i++) {
    const ch = source[i];

    if (quote) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === quote) quote = "";
      continue;
    }

    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }

    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) return { start: match.index, end: i + 1 };
    }
  }

  throw new Error(`Could not find end of function ${name}`);
}

function insertBeforeGetSyncState(snippet) {
  const fn = findFunction(src, "getSyncState");
  src = src.slice(0, fn.start) + snippet + "\n" + src.slice(fn.start);
}

const remoteStateAndPoll = `
type RemoteSyncHealth = {
  book?: string;
  status?: string;
  lastCheckedAt?: string | null;
  matched?: number;
  tallyToApp?: number;
  appToTally?: number;
  conflicts?: number;
  errors?: number;
  message?: string;
};

const [remoteSyncHealth, setRemoteSyncHealth] = useState<Record<string, RemoteSyncHealth | null>>({ us: null, india: null });

useEffect(() => {
  let alive = true;

  const check = async () => {
    try {
      const response = await fetch("/api/sync-status?book=" + encodeURIComponent(book), { cache: "no-store" });
      if (!alive || !response.ok) return;
      const health = await response.json();
      setRemoteSyncHealth((current) => ({ ...current, [book]: health }));
    } catch {
      // Keep the last known status if the status endpoint is briefly unavailable.
    }
  };

  check();
  const timer = setInterval(check, 10000);

  return () => {
    alive = false;
    clearInterval(timer);
  };
}, [book]);
`;

const remotePollOnly = `
useEffect(() => {
  let alive = true;

  const check = async () => {
    try {
      const response = await fetch("/api/sync-status?book=" + encodeURIComponent(book), { cache: "no-store" });
      if (!alive || !response.ok) return;
      const health = await response.json();
      setRemoteSyncHealth((current) => ({ ...current, [book]: health }));
    } catch {}
  };

  check();
  const timer = setInterval(check, 10000);

  return () => {
    alive = false;
    clearInterval(timer);
  };
}, [book]);
`;

if (!/\bremoteSyncHealth\b/.test(src)) {
  insertBeforeGetSyncState(remoteStateAndPoll);
} else if (!/\/api\/sync-status\?book=/.test(src)) {
  insertBeforeGetSyncState(remotePollOnly);
}

const getSyncState = `function getSyncState(data: any, syncBook: "us" | "india" = book) {
  const health = remoteSyncHealth?.[syncBook] || null;
  const status = String(health?.status || "").toLowerCase();
  const last = health?.lastCheckedAt ? new Date(health.lastCheckedAt).getTime() : NaN;
  const age = Number.isFinite(last) ? Date.now() - last : Infinity;
  const fresh = Number.isFinite(age) && Math.abs(age) < 10 * 60 * 1000;

  const tallyToApp = Number(health?.tallyToApp || 0);
  const appToTally = Number(health?.appToTally || 0);
  const conflicts = Number(health?.conflicts || 0);
  const errors = Number(health?.errors || 0);
  const pending = tallyToApp + appToTally;

  if (fresh) {
    if (status === "error" || errors > 0 || conflicts > 0) {
      const count = errors + conflicts || 1;
      return { tone: "error" as const, label: String(count) + " sync issue" + (count === 1 ? "" : "s") };
    }

    if (status === "pending" || pending > 0) {
      const count = pending || 1;
      return { tone: "pending" as const, label: String(count) + " pending sync item" + (count === 1 ? "" : "s") };
    }

    if (status === "success" || status === "ok" || status === "synced") {
      return { tone: "success" as const, label: "Sync successful" };
    }
  }

  const tx = data?.transactions || [];
  const accounts = data?.accounts || [];
  const groups = data?.groups || [];

  const hasAppChange = (item: any) => String(item?.syncFingerprint || "").startsWith("app-change-");
  const isPending = (item: any) => {
    const state = String(item?.syncStatus || "").toLowerCase();
    return state === "pending" || hasAppChange(item);
  };
  const isError = (item: any) => {
    const state = String(item?.syncStatus || "").toLowerCase();
    return state === "error" || state === "failed";
  };

  const localErrors = tx.filter(isError).length + accounts.filter(isError).length + groups.filter(isError).length;
  const localPending = tx.filter(isPending).length + accounts.filter(isPending).length + groups.filter(isPending).length;

  if (localErrors > 0) {
    return { tone: "error" as const, label: String(localErrors) + " sync issue" + (localErrors === 1 ? "" : "s") };
  }

  if (localPending > 0) {
    return { tone: "pending" as const, label: String(localPending) + " pending sync item" + (localPending === 1 ? "" : "s") };
  }

  return { tone: "success" as const, label: "Sync successful" };
}`;

const fn = findFunction(src, "getSyncState");
src = src.slice(0, fn.start) + getSyncState + src.slice(fn.end);

src = src.replace(/getSyncState\(data\)/g, "getSyncState(data, book)");

fs.writeFileSync(tsxPath, src, "utf8");

const cssPath = path.join(process.cwd(), "app", "globals.css");
if (fs.existsSync(cssPath)) {
  let css = fs.readFileSync(cssPath, "utf8");
  if (!css.includes(".sync-lock-button.success")) {
    css += `
.sync-lock-button.success{background:#dcfce7!important;border-color:#22c55e!important;color:#166534!important}
.sync-lock-button.pending{background:#fef9c3!important;border-color:#facc15!important;color:#854d0e!important}
.sync-lock-button.error{background:#fee2e2!important;border-color:#ef4444!important;color:#991b1b!important}
`;
    fs.writeFileSync(cssPath, css, "utf8");
  }
}

console.log("Authoritative sync status source repair applied.");
console.log("Backup created:", `${tsxPath}.backup-authoritative-sync-status-${stamp}`);
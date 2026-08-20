const fs = require("fs");
const path = require("path");

const root = process.cwd();
const tsxPath = path.join(root, "components", "VaultApp.tsx");
const routePath = path.join(root, "app", "api", "sync-status", "route.ts");

if (!fs.existsSync(tsxPath)) {
  throw new Error("STOP: components\\VaultApp.tsx not found. Run from personal-accounting-app folder.");
}

if (!fs.existsSync(routePath)) {
  throw new Error("STOP: app\\api\\sync-status\\route.ts not found. Do not deploy; sync status API is missing.");
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupPath = `${tsxPath}.backup-sync-source-${stamp}`;
fs.copyFileSync(tsxPath, backupPath);

let s = fs.readFileSync(tsxPath, "utf8");

function findFunction(src, name) {
  const start = src.indexOf(`function ${name}`);
  if (start < 0) return null;

  const brace = src.indexOf("{", start);
  if (brace < 0) return null;

  let depth = 0;
  let quote = null;
  let escape = false;

  for (let i = brace; i < src.length; i++) {
    const ch = src[i];

    if (quote) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }

    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) return { start, end: i + 1 };
    }
  }

  return null;
}

function ensureReactHook(src, hook) {
  if (new RegExp(`\\b${hook}\\b`).test(src.match(/import[\s\S]*?from\s+["']react["'];?/)?.[0] || "")) {
    return src;
  }

  return src.replace(
    /import\s+React\s*,\s*\{([^}]+)\}\s+from\s+["']react["'];?/,
    (m, hooks) => {
      const list = hooks.split(",").map(x => x.trim()).filter(Boolean);
      if (!list.includes(hook)) list.push(hook);
      return `import React, { ${list.join(", ")} } from "react";`;
    }
  ).replace(
    /import\s+\{([^}]+)\}\s+from\s+["']react["'];?/,
    (m, hooks) => {
      const list = hooks.split(",").map(x => x.trim()).filter(Boolean);
      if (!list.includes(hook)) list.push(hook);
      return `import { ${list.join(", ")} } from "react";`;
    }
  );
}

s = ensureReactHook(s, "useEffect");
s = ensureReactHook(s, "useState");

if (!/type\s+RemoteSyncHealth\b|interface\s+RemoteSyncHealth\b/.test(s)) {
  const remoteType = `
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
`;

  const imports = [...s.matchAll(/^import[\s\S]*?;$/gm)];
  if (imports.length) {
    const last = imports[imports.length - 1];
    const pos = last.index + last[0].length;
    s = s.slice(0, pos) + "\n" + remoteType + s.slice(pos);
  } else {
    s = remoteType + "\n" + s;
  }
}

const getSyncStateBlock = String.raw`
function getSyncState(data: any, book: string, remote: RemoteSyncHealth | null) {
  const rows = [
    ...((data?.transactions || []) as any[]),
    ...((data?.accounts || []) as any[]),
    ...(((data as any)?.groups || []) as any[]),
  ];

  const localErrors = rows.filter((x) => String(x?.syncStatus || "").toLowerCase() === "error").length;

  const appChangeTime = (x: any) => {
    const fp = String(x?.syncFingerprint || "");
    const match = fp.match(/^app-change-(\d{10,})/);
    return match ? Number(match[1]) : 0;
  };

  const newestLocalAppChange = rows.reduce((max, row) => Math.max(max, appChangeTime(row)), 0);
  const remoteCheckedAt = remote?.lastCheckedAt ? new Date(remote.lastCheckedAt).getTime() : 0;
  const localChangeAfterRemoteCheck = newestLocalAppChange > remoteCheckedAt;

  const status = String(remote?.status || "").toLowerCase();
  const remoteTallyToApp = Number(remote?.tallyToApp || 0);
  const remoteAppToTally = Number(remote?.appToTally || 0);
  const remoteConflicts = Number(remote?.conflicts || 0);
  const remoteErrors = Number(remote?.errors || 0);

  if (status === "error" || remoteConflicts > 0 || remoteErrors > 0 || localErrors > 0) {
    const count = remoteConflicts || remoteErrors || localErrors || 1;
    return {
      tone: "error",
      label: String(count) + " sync issue" + (count === 1 ? "" : "s"),
    };
  }

  if (
    status === "pending" ||
    remoteTallyToApp > 0 ||
    remoteAppToTally > 0 ||
    localChangeAfterRemoteCheck
  ) {
    const count = remoteTallyToApp + remoteAppToTally || 1;
    return {
      tone: "pending",
      label: String(count) + " item" + (count === 1 ? "" : "s") + " pending sync",
    };
  }

  if (status === "success") {
    return { tone: "success", label: "Sync successful" };
  }

  return { tone: "pending", label: "Sync status pending" };
}
`;

const fn = findFunction(s, "getSyncState");
if (!fn) {
  throw new Error("STOP: Could not find function getSyncState in VaultApp.tsx. No source change written.");
}
s = s.slice(0, fn.start) + getSyncStateBlock + s.slice(fn.end);

const syncStateLineRe = /const\s+syncState\s*=\s*getSyncState\([^;]*\)\s*;/;
if (!syncStateLineRe.test(s)) {
  throw new Error("STOP: Could not find syncState declaration in VaultApp.tsx. No source change written.");
}

if (!/setRemoteSyncHealth/.test(s)) {
  const remoteHook = [
    "  const [remoteSyncHealth, setRemoteSyncHealth] = useState<RemoteSyncHealth | null>(null);",
    "  useEffect(() => {",
    "    let cancelled = false;",
    "    async function refreshSyncHealth() {",
    "      try {",
    "        const res = await fetch(`/api/sync-status?book=${book}`, { cache: \"no-store\" });",
    "        if (!res.ok) throw new Error(String(res.status));",
    "        const next = (await res.json()) as RemoteSyncHealth;",
    "        if (!cancelled) setRemoteSyncHealth(next);",
    "      } catch {",
    "        if (!cancelled) setRemoteSyncHealth(null);",
    "      }",
    "    }",
    "    refreshSyncHealth();",
    "    const id = window.setInterval(refreshSyncHealth, 10000);",
    "    return () => {",
    "      cancelled = true;",
    "      window.clearInterval(id);",
    "    };",
    "  }, [book]);",
    ""
  ].join("\n");

  s = s.replace(syncStateLineRe, remoteHook + "$&");
}

s = s.replace(syncStateLineRe, "const syncState = getSyncState(data, book, remoteSyncHealth);");

if (!/const\s+syncTone\s*=/.test(s)) {
  s = s.replace(
    "const syncState = getSyncState(data, book, remoteSyncHealth);",
    "const syncState = getSyncState(data, book, remoteSyncHealth);\n  const syncTone = syncState.tone;"
  );
}

if (!/const\s+syncLabel\s*=/.test(s)) {
  s = s.replace(
    /const\s+syncTone\s*=\s*syncState\.tone\s*;/,
    "const syncTone = syncState.tone;\n  const syncLabel = syncState.label;"
  );
}

s = s.replace(
  /syncStatus\s*:\s*["']pending["']\s*,\s*(lastSyncedAt\s*:\s*editTx\.lastSyncedAt\s*,?)/g,
  "$1"
);

if (!/sync-lock-button\s+\$\{syncTone\}|sync-lock-button\s+\$\{syncState\.tone\}/.test(s)) {
  s = s.replace(/className="sync-lock-button"/g, "className={`sync-lock-button ${syncTone}`}");
}

fs.writeFileSync(tsxPath, s, "utf8");

const cssCandidates = [
  path.join(root, "app", "globals.css"),
  path.join(root, "app", "global.css"),
  path.join(root, "styles", "globals.css"),
];

const cssPath = cssCandidates.find((p) => fs.existsSync(p));
if (cssPath) {
  let css = fs.readFileSync(cssPath, "utf8");
  if (!/\.sync-lock-button\.success/.test(css)) {
    css += `

.sync-lock-button.success{background:#dcfce7!important;border-color:#86efac!important;color:#166534!important}
.sync-lock-button.pending{background:#fef9c3!important;border-color:#facc15!important;color:#854d0e!important}
.sync-lock-button.error{background:#fee2e2!important;border-color:#f87171!important;color:#991b1b!important}
.sync-lock-button svg{display:block}
`;
    fs.writeFileSync(cssPath, css, "utf8");
  }
}

console.log("Source repair complete.");
console.log("Backup saved:", backupPath);
console.log("Next: run npm run build. Deploy only if build succeeds.");
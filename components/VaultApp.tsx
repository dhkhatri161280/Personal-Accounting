"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { TransactionTable } from "@/components/TransactionTable";
import { MastersPanel, type MasterGroup } from "@/components/MastersPanel";
import { validateVoucher } from "@/lib/voucher-validation";
import type {
  Entry,
  VoucherLineDraft,
  Tx,
  Account,
  Ledger,
  Vault,
  SyncHealth,
} from "@/lib/vault-types";
import {
  bytes,
  b64,
  url64,
  fromUrl64,
  aesKey,
  contentEtag,
  decryptVault,
  encryptVault,
} from "@/lib/vault-crypto";
import {
  blankVoucherLines,
  draftLinesFromTx,
  centsOf,
  fiscalYearOf,
  nextVoucherNumber,
  nextTransactionIds,
  recomputeVoucherNumbers,
  cleanText,
  isDebitNatureAccount,
  displayLedgerBalance,
  cleanVoucherDisplay,
  formatVoucherDisplayDate,
  voucherSideLedgerNames,
} from "@/lib/vault-accounting";
import { fmtDate } from "@/lib/format-date";
import { SyncStatusLock } from "@/components/vault/SyncStatusLock";
import { PlaidImport } from "@/components/vault/PlaidImport";
import { SchwabImport } from "@/components/vault/SchwabImport";
import { UnlockScreen } from "@/components/vault/UnlockScreen";
import { GroupedReport } from "@/components/reports/GroupedReport";
import { CashFlowReport } from "@/components/reports/CashFlowReport";
import { BalanceSheetReport } from "@/components/reports/BalanceSheetReport";
import { NetWorthReport, equityHoldingsRow, retirementLiveRow } from "@/components/reports/NetWorthReport";
import { computeNetWorthTrend } from "@/lib/net-worth-trend";
import { computeHeldEquityValueAsOf, priceAsOf, type PricePoint } from "@/lib/equity-holdings";
import { EquityReport } from "@/components/reports/EquityReport";
import { TradingReport } from "@/components/reports/TradingReport";
import { RetirementReport } from "@/components/reports/RetirementReport";
import { TaxReport } from "@/components/reports/TaxReport";
import { IndiaTaxReport } from "@/components/reports/IndiaTaxReport";
import { ReconReport } from "@/components/reports/ReconReport";
import { StatIcon } from "@/components/Icon";
import { DonutChart, DONUT_PALETTE } from "@/components/DonutChart";
import { VoucherTypeBadge, VoucherFlow } from "@/components/VoucherVisual";
import { FloatingWindow } from "@/components/FloatingWindow";

const BIO_KEY = "personal-ledger-biometric-v1";

const VOUCHER_TYPE_ICONS: Record<string, string> = {
  payment: "💸",
  receipt: "💰",
  contra: "🔄",
  journal: "📔",
};
const voucherTypeIcon = (type: string) => VOUCHER_TYPE_ICONS[type.toLowerCase()] || "📄";

function autoBalance(lines: VoucherLineDraft[], changedIndex: number): VoucherLineDraft[] {
  const last = lines.length - 1;
  if (lines.length < 2) return lines;
  if (lines.length === 2) {
    // 2-line: mirror the typed amount to the other line
    const other = changedIndex === 0 ? 1 : 0;
    return lines.map((row, i) => (i === other ? { ...row, amount: lines[changedIndex].amount } : row));
  }
  // Multi-line: auto-compute last line as running balance when any non-last line changes
  if (changedIndex === last) return lines;
  let drSum = 0, crSum = 0;
  for (let i = 0; i < last; i++) {
    const a = Math.abs(Number(lines[i].amount) || 0);
    if (lines[i].side === "debit") drSum += a;
    else crSum += a;
  }
  const diff = drSum - crSum;
  const newSide: "debit" | "credit" = diff >= 0 ? "credit" : "debit";
  const newAmt = Math.abs(diff);
  return lines.map((row, i) =>
    i === last ? { ...row, side: newSide, amount: newAmt > 0.005 ? newAmt.toFixed(2) : "" } : row
  );
}

export function VaultApp({ book = "us" }: { book?: "us" | "india" }) {
  const apiUrl = book === "india" ? "/api/vault?book=india" : "/api/vault",
    biometricKey = `${BIO_KEY}-${book}`,
    sharedBiometricKey = `${BIO_KEY}-shared`,
    sessionKey = `personal-ledger-session-${book}`,
    sharedSessionKey = "personal-ledger-shared-session",
    biometricSessionKey = "personal-ledger-biometric-session",
    unifiedSecretKey = "fintech-unified-prf-secret",
    unifiedSealKey = "fintech-unified-vault-seal";
  const autoBiometricStarted = useRef(false),
    entryFormRef = useRef<HTMLFormElement>(null),
    newVoucherMenuRef = useRef<HTMLDivElement>(null),
    autoSyncTriggerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [password, setPassword] = useState(""),
    [data, setData] = useState<Ledger | null>(null),
    [status, setStatus] = useState(""),
    [lastSynced, setLastSynced] = useState(""),
    [hasBiometric, setHasBiometric] = useState(false),
    [biometricChecked, setBiometricChecked] = useState(false),
    [showPasswordFallback, setShowPasswordFallback] = useState(false),
    [tab, setTab] = useState("dashboard"),
    [importSource, setImportSource] = useState<"plaid" | "schwab" | "retirement">("plaid"),
    [trashSubTab, setTrashSubTab] = useState<"deleted" | "duplicate">("deleted"),
    [privacyMode, setPrivacyMode] = useState(() => typeof window !== "undefined" && localStorage.getItem("dk-privacy") === "1"),
    [uiTheme, setUiTheme] = useState<"classic" | "refresh">(() =>
      typeof window !== "undefined" && localStorage.getItem("dk-ui-theme") === "refresh" ? "refresh" : "classic"
    ),
    [report, setReport] = useState("trial"),
    [year, setYear] = useState("all"),
    [customStart, setCustomStart] = useState("2026-04"),
    [customEnd, setCustomEnd] = useState("2026-06"),
    [query, setQuery] = useState(""),
    [showAllVouchers, setShowAllVouchers] = useState(false),
    [tableFilter, setTableFilter] = useState(""),
    [minAmount, setMinAmount] = useState(""),
    [sortKey, setSortKey] = useState("name"),
    [sortDir, setSortDir] = useState<"asc" | "desc">("asc"),
    [copyTx, setCopyTx] = useState<Tx | null>(null),
    [editTx, setEditTx] = useState<Tx | null>(null),
    [newVoucherType, setNewVoucherType] = useState<string | null>(null),
    [newVoucherMenuOpen, setNewVoucherMenuOpen] = useState(false),
    [dashboardDetail, setDashboardDetail] = useState<
      "cash" | "investments" | "fixedAssets" | "capital" | "salary" | "active" | "period" | null
    >(null),
    [cashFlowDetail, setCashFlowDetail] = useState<{ group: string; ledger?: string } | null>(null),
    [selected, setSelected] = useState<number | null>(null),
    [selectedVoucher, setSelectedVoucher] = useState<Tx | null>(null),
    [inlineLedgerSide, setInlineLedgerSide] = useState<"debit" | "credit" | null>(null),
    [voucherLines, setVoucherLines] = useState<VoucherLineDraft[]>(blankVoucherLines()),
    [vaultEtag, setVaultEtag] = useState(""),
    [nvdaPrice, setNvdaPrice] = useState<number | null>(null),
    [nvdaPrevClose, setNvdaPrevClose] = useState<number | null>(null),
    [nvdaHistory, setNvdaHistory] = useState<PricePoint[]>([]),
    // Live 401(k)/IRA balance from Plaid (Fidelity + Merrill), for Net Worth to value retirement
    // accounts at real market value instead of the ledger's book value (cumulative payroll
    // contributions) -- same "live value alongside/instead of book value" idea as heldEquity
    // below for RSU/ESPP. null = not fetched yet (or fetch failed); Net Worth falls back to the
    // book-value ledger row in that case rather than silently showing $0.
    [liveRetirementBalance, setLiveRetirementBalance] = useState<number | null>(null);

  async function cacheUnifiedVaultPassword(pw: string) {
    const secret = sessionStorage.getItem(unifiedSecretKey);
    if (!secret) return;
    const key = await aesKey(fromUrl64(secret).buffer as ArrayBuffer),
      iv = crypto.getRandomValues(new Uint8Array(12)),
      sealed = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        new TextEncoder().encode(pw)
      );
    localStorage.setItem(unifiedSealKey, JSON.stringify({ iv: url64(iv), sealed: url64(sealed) }));
  }

  async function unifiedVaultPassword() {
    const secret = sessionStorage.getItem(unifiedSecretKey),
      raw = localStorage.getItem(unifiedSealKey);
    if (!secret || !raw) throw Error();
    const config = JSON.parse(raw),
      key = await aesKey(fromUrl64(secret).buffer as ArrayBuffer),
      plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: fromUrl64(config.iv) },
        key,
        fromUrl64(config.sealed)
      );
    return new TextDecoder().decode(plain);
  }

  async function openVault(pw: string) {
    const response = await fetch(apiUrl, { cache: "no-store" });
    if (!response.ok) throw Error();
    const raw = await response.text(),
      etag = await contentEtag(raw),
      v = JSON.parse(raw) as Vault,
      decrypted = await decryptVault(v, pw),
      repaired = recomputeVoucherNumbers(decrypted);
    setVaultEtag(etag);
    setPassword(pw);
    setData(decrypted);
    const latestFiscalYear = decrypted.transactions
      .filter((t) => !t.deleted && /^\d{4}-\d{2}-\d{2}$/.test(t.date))
      .reduce((latest, t) => Math.max(latest, fiscalYearOf(t.date)), 0);
    if (latestFiscalYear) setYear(String(latestFiscalYear));
    sessionStorage.setItem(sessionKey, pw);
    await cacheUnifiedVaultPassword(pw).catch(() => {});
    setLastSynced(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
    if (repaired) {
      setStatus("Correcting duplicate voucher number and saving securely...");
      const corrected = await encryptVault(decrypted, pw),
        saved = await fetch(apiUrl, {
          method: "PUT",
          headers: { "Content-Type": "application/json", "If-Match": etag },
          body: JSON.stringify(corrected),
        });
      if (!saved.ok) throw Error();
      const repairedSave = (await saved.json().catch(() => null)) as { etag?: string } | null;
      if (repairedSave?.etag) setVaultEtag(repairedSave.etag);
      const infoMsg = "Auto-fixed a duplicate voucher number — no action needed.";
      setStatus(infoMsg);
      setTimeout(() => setStatus((s) => (s === infoMsg ? "" : s)), 5000);
    } else setStatus("");
  }

  async function unlock(e: React.FormEvent) {
    e.preventDefault();
    setStatus("Decrypting locally...");
    try {
      await openVault(password);
    } catch {
      setStatus("Unable to unlock. Check the vault password.");
    }
  }

  async function enableBiometric() {
    try {
      if (!window.PublicKeyCredential) throw Error("WebAuthn is unavailable");
      setStatus("Waiting for device biometric confirmation...");
      const salt = crypto.getRandomValues(new Uint8Array(32)),
        challenge = crypto.getRandomValues(new Uint8Array(32)),
        userId = crypto.getRandomValues(new Uint8Array(32)),
        credential = (await navigator.credentials.create({
          publicKey: {
            challenge,
            rp: { name: "FinTech by DK", id: location.hostname },
            user: { id: userId, name: "personal-ledger-owner", displayName: "FinTech by DK Owner" },
            pubKeyCredParams: [
              { alg: -7, type: "public-key" },
              { alg: -257, type: "public-key" },
            ],
            authenticatorSelection: {
              authenticatorAttachment: "platform",
              residentKey: "required",
              userVerification: "required",
            },
            timeout: 60000,
            attestation: "none",
            extensions: { prf: { eval: { first: salt } } } as object,
          },
        })) as PublicKeyCredential | null;
      if (!credential) throw Error("Biometric setup was cancelled");
      let secret = (
        credential.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } }
      )?.prf?.results?.first;
      if (!secret) {
        const assertion = (await navigator.credentials.get({
          publicKey: {
            challenge: crypto.getRandomValues(new Uint8Array(32)),
            allowCredentials: [{ id: credential.rawId, type: "public-key" }],
            userVerification: "required",
            timeout: 60000,
            extensions: { prf: { eval: { first: salt } } } as object,
          },
        })) as PublicKeyCredential | null;
        secret = (
          assertion?.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } }
        )?.prf?.results?.first;
      }
      if (!secret) throw Error("This biometric provider does not support secure PRF unlock");
      const key = await aesKey(secret),
        iv = crypto.getRandomValues(new Uint8Array(12)),
        sealed = await crypto.subtle.encrypt(
          { name: "AES-GCM", iv },
          key,
          new TextEncoder().encode(password)
        );
      const biometricConfig = JSON.stringify({
        credentialId: url64(credential.rawId),
        salt: url64(salt),
        iv: url64(iv),
        sealed: url64(sealed),
      });
      localStorage.setItem(sharedBiometricKey, biometricConfig);
      localStorage.setItem(biometricKey, biometricConfig);
      setHasBiometric(true);
      setStatus("Biometric unlock enabled on this device.");
    } catch (e) {
      setStatus(
        e instanceof Error
          ? e.message
          : "Biometric setup failed. Password unlock remains available."
      );
    }
  }

  async function biometricUnlock() {
    try {
      setStatus("Confirm your identity on this device...");
      const stored =
          localStorage.getItem(sharedBiometricKey) ||
          localStorage.getItem(biometricKey) ||
          localStorage.getItem(`${BIO_KEY}-${book === "us" ? "india" : "us"}`),
        config = JSON.parse(stored || "null") as {
          credentialId: string;
          salt: string;
          iv: string;
          sealed: string;
        } | null;
      if (stored && !localStorage.getItem(sharedBiometricKey))
        localStorage.setItem(sharedBiometricKey, stored);
      if (!config) throw Error("Biometric unlock is not configured on this device");
      const assertion = (await navigator.credentials.get({
          publicKey: {
            challenge: crypto.getRandomValues(new Uint8Array(32)),
            allowCredentials: [{ id: fromUrl64(config.credentialId), type: "public-key" }],
            userVerification: "required",
            timeout: 60000,
            extensions: { prf: { eval: { first: fromUrl64(config.salt) } } } as object,
          },
        })) as PublicKeyCredential | null,
        secret = (
          assertion?.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } }
        )?.prf?.results?.first;
      if (!secret) throw Error("Secure biometric key was not returned");
      const key = await aesKey(secret),
        plain = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: fromUrl64(config.iv) },
          key,
          fromUrl64(config.sealed)
        ),
        pw = new TextDecoder().decode(plain);
      sessionStorage.setItem(sharedSessionKey, pw);
      sessionStorage.setItem("personal-ledger-session-us", pw);
      sessionStorage.setItem("personal-ledger-session-india", pw);
      sessionStorage.setItem(biometricSessionKey, "1");
      await openVault(pw);
    } catch {
      setStatus("Biometric unlock failed. Use your vault password instead.");
    }
  }

  function removeBiometric() {
    localStorage.removeItem(sharedBiometricKey);
    localStorage.removeItem(`${BIO_KEY}-us`);
    localStorage.removeItem(`${BIO_KEY}-india`);
    setHasBiometric(false);
    setShowPasswordFallback(true);
    setStatus("Biometric unlock removed from this device.");
  }

  async function lockVault() {
    try {
      await fetch("/_auth/logout", { method: "POST" });
    } catch {}
    sessionStorage.removeItem("personal-ledger-session-us");
    sessionStorage.removeItem("personal-ledger-session-india");
    sessionStorage.removeItem(sharedSessionKey);
    sessionStorage.removeItem(biometricSessionKey);
    sessionStorage.removeItem(unifiedSecretKey);
    setData(null);
    setPassword("");
  }

  async function save(next: Ledger, destination = "daybook"): Promise<boolean> {
    recomputeVoucherNumbers(next);
    setStatus("Encrypting and saving...");
    const vault = await encryptVault(next, password),
      r = await fetch(apiUrl, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          ...(vaultEtag ? { "If-Match": vaultEtag } : {}),
        },
        body: JSON.stringify(vault),
      });
    if (r.status === 412) {
      await syncNow(true);
      setStatus(
        "Newer synchronized data was loaded. Your form values are retained; review and save again."
      );
      return false;
    }
    if (r.status === 428) {
      setStatus("Save failed: session expired. Please lock and re-open the vault, then try again.");
      return false;
    }
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      setStatus(`Save failed (${r.status}${detail ? ": " + detail : ""})`);
      return false;
    }
    const saved = (await r.json().catch(() => null)) as { etag?: string } | null;
    if (saved?.etag) setVaultEtag(saved.etag);
    setData(next);
    setLastSynced(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
    setStatus("Encrypted save complete");
    setTab(destination);
    scheduleAutoSyncTrigger();
    return true;
  }

  // Debounce: wait until saves settle before asking the local Tally daemon to sync,
  // so entering several vouchers in a row triggers one sync, not one per voucher.
  function scheduleAutoSyncTrigger() {
    if (autoSyncTriggerTimer.current) clearTimeout(autoSyncTriggerTimer.current);
    autoSyncTriggerTimer.current = setTimeout(() => {
      autoSyncTriggerTimer.current = null;
      fetch(`/api/sync-trigger?book=${book}`, { method: "POST", cache: "no-store" }).catch(() => {});
    }, 20000);
  }

  async function syncNow(silent = false) {
    if (!data) return;
    try {
      if (!silent) setStatus("Syncing encrypted vault...");
      const response = await fetch(
        `${apiUrl}${apiUrl.includes("?") ? "&" : "?"}sync=${Date.now()}`,
        { cache: "no-store" }
      );
      if (!response.ok) throw Error();
      const raw = await response.text(),
        etag = await contentEtag(raw),
        v = JSON.parse(raw) as Vault,
        latest = await decryptVault(v, password);
      setVaultEtag(etag);
      setData(latest);
      setLastSynced(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
      if (!silent) setStatus("Cloud sync complete");
    } catch {
      if (!silent) setStatus("Unable to sync. Your current screen remains unchanged.");
    }
  }

  useEffect(() => {
    const unifiedReady =
      !!sessionStorage.getItem(unifiedSecretKey) && !!localStorage.getItem(unifiedSealKey);
    if (unifiedReady) {
      setHasBiometric(true);
      setBiometricChecked(true);
      setShowPasswordFallback(false);
      void unifiedVaultPassword()
        .then(openVault)
        .catch(() => {
          localStorage.removeItem(unifiedSealKey);
          setShowPasswordFallback(true);
        });
      return;
    }
    const stored =
        localStorage.getItem(sharedBiometricKey) ||
        localStorage.getItem(biometricKey) ||
        localStorage.getItem(`${BIO_KEY}-${book === "us" ? "india" : "us"}`),
      configured = !!stored;
    if (stored && !localStorage.getItem(sharedBiometricKey))
      localStorage.setItem(sharedBiometricKey, stored);
    setHasBiometric(configured);
    setBiometricChecked(true);
    setShowPasswordFallback(!configured);
    const cached = sessionStorage.getItem(sessionKey) || sessionStorage.getItem(sharedSessionKey),
      biometricSession = sessionStorage.getItem(biometricSessionKey) === "1";
    if (configured && (!cached || !biometricSession) && !autoBiometricStarted.current) {
      autoBiometricStarted.current = true;
      void biometricUnlock();
    } else if (cached) {
      openVault(cached).catch(() => {
        sessionStorage.removeItem(sessionKey);
        sessionStorage.removeItem(sharedSessionKey);
        sessionStorage.removeItem(biometricSessionKey);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const handler = () => setTab("dashboard");
    window.addEventListener("dk-nav-home", handler);
    return () => window.removeEventListener("dk-nav-home", handler);
  }, []);

  useEffect(() => {
    if (!newVoucherMenuOpen) return;
    const onOutside = (e: MouseEvent) => {
      if (newVoucherMenuRef.current && !newVoucherMenuRef.current.contains(e.target as Node))
        setNewVoucherMenuOpen(false);
    };
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [newVoucherMenuOpen]);

  useEffect(() => {
    if (!data) return;
    let checking = false;
    const check = async () => {
        if (checking || document.visibilityState !== "visible") return;
        checking = true;
        try {
          const response = await fetch(
              `${apiUrl}${apiUrl.includes("?") ? "&" : "?"}revision=${Date.now()}`,
              { method: "HEAD", cache: "no-store" }
            ),
            remote = response.headers.get("ETag");
          if (response.ok && remote && remote !== vaultEtag) await syncNow(true);
        } catch {
        } finally {
          checking = false;
        }
      },
      timer = setInterval(check, 120000),
      visible = () => {
        if (document.visibilityState === "visible") check();
      };
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [data, password, vaultEtag]);

  useEffect(() => {
    if (!data?.equity) return;
    fetch("/api/equity-price?ticker=NVDA")
      .then((r) => r.json())
      .then((d: unknown) => {
        const j = d as { price?: number | null; previousClose?: number | null };
        if (typeof j.price === "number") setNvdaPrice(j.price);
        if (typeof j.previousClose === "number") setNvdaPrevClose(j.previousClose);
      })
      .catch(() => {});
  }, [data?.equity]);

  // Daily close history for valuing vested equity as of a *past* fiscal year-end (Net Worth),
  // instead of applying today's live price to every historical period.
  useEffect(() => {
    if (!data?.equity) return;
    fetch("/api/equity-price-history?ticker=NVDA")
      .then((r) => r.json())
      .then((d: unknown) => {
        const j = d as { points?: PricePoint[] };
        if (Array.isArray(j.points)) setNvdaHistory(j.points.slice().sort((a, b) => a.date.localeCompare(b.date)));
      })
      .catch(() => {});
  }, [data?.equity]);

  // Live 401(k)/IRA balance (Fidelity + Merrill) via the same Plaid Balances product the
  // Retirement tab uses -- fetched once here too so Net Worth can value retirement accounts at
  // real market value. book === "india" has no US brokerage connections to fetch.
  useEffect(() => {
    if (book === "india") return;
    fetch("/api/plaid/transactions")
      .then((r) => r.json())
      .then((d: unknown) => {
        const j = d as { accounts?: { type: string; subtype: string; balances: { current: number | null } }[] };
        const retirementAccts = (j.accounts ?? []).filter((a) => a.type === "investment" && a.subtype !== "hsa");
        if (retirementAccts.length) setLiveRetirementBalance(retirementAccts.reduce((s, a) => s + (a.balances?.current ?? 0), 0));
      })
      .catch(() => {});
  }, [book]);

  const calc = useMemo(() => {
    const empty = {
      opening: new Map<number, number>(),
      debit: new Map<number, number>(),
      credit: new Map<number, number>(),
      closing: new Map<number, number>(),
      period: [] as Tx[],
    };
    if (!data) return empty;
    const start =
        year === "all"
          ? "0000-00-00"
          : year === "custom"
            ? `${customStart}-01`
            : year.length === 7
              ? `${year}-01`
              : `${year}-04-01`,
      end =
        year === "all"
          ? "9999-99-99"
          : year === "custom"
            ? `${customEnd}-31`
            : year.length === 7
              ? `${year}-31`
              : `${Number(year) + 1}-03-31`,
      opening = new Map(data.accounts.map((a) => [a.id, a.openingBalance])),
      debit = new Map<number, number>(),
      credit = new Map<number, number>(),
      period: Tx[] = [];
    for (const t of data.transactions) {
      if (t.deleted) continue;
      if (t.cancelled) {
        if (t.date >= start && t.date <= end) period.push(t);
        continue;
      }
      if (t.date < start) {
        for (const e of t.entries)
          opening.set(e.accountId, (opening.get(e.accountId) || 0) + e.amount);
      } else if (t.date <= end) {
        period.push(t);
        for (const e of t.entries) {
          if (e.amount < 0) debit.set(e.accountId, (debit.get(e.accountId) || 0) - e.amount);
          else credit.set(e.accountId, (credit.get(e.accountId) || 0) + e.amount);
        }
      }
    }
    const closing = new Map<number, number>();
    for (const a of data.accounts)
      closing.set(
        a.id,
        (opening.get(a.id) || 0) - (debit.get(a.id) || 0) + (credit.get(a.id) || 0)
      );
    return { opening, debit, credit, closing, period };
  }, [data, year, customStart, customEnd]);

  // Full-history net worth trend, independent of the report's selected period (year/custom
  // range) -- net worth is a "since inception" view, not a period-scoped one like the other reports.
  const netWorthTrend = useMemo(() => {
    if (!data) return [];
    return computeNetWorthTrend(data.accounts, data.transactions, data.groups || []);
  }, [data]);

  const { cashFlowItems, cashFlowGroups } = useMemo(() => {
    if (!data) return { cashFlowItems: [], cashFlowGroups: [] };
    const tol = 0.005;
    const isCb = (a: Account) => /^(bank accounts|cash-in-hand)$/.test((a.parent || "").toLowerCase());
    const cashIds = new Set(data.accounts.filter(isCb).map((a) => a.id));
    const accountById = new Map(data.accounts.map((a) => [a.id, a]));
    const items = calc.period
      .filter((t) => !t.cancelled)
      .flatMap((t) => {
        const cashEntries = t.entries.filter((e) => cashIds.has(e.accountId)),
          cashMovement = -cashEntries.reduce((s, e) => s + e.amount, 0);
        if (!cashEntries.length || Math.abs(cashMovement) <= tol) return [];
        return t.entries
          .filter((e) => !cashIds.has(e.accountId) && Math.abs(e.amount) > tol)
          .map((e, i) => {
            const account = accountById.get(e.accountId),
              group = account?.parent || "Other",
              ledger = account?.name || e.accountName || "Unknown Ledger",
              amount = Math.abs(e.amount),
              kind = e.amount > 0 ? "inflow" : "outflow";
            return { t, entry: e, entryIndex: i, group, ledger, amount, kind, movement: kind === "inflow" ? amount : -amount };
          });
      });
    const groups = [
      ...items
        .reduce(
          (m, x) => {
            const v = m.get(x.group) || { group: x.group, inflow: 0, outflow: 0, inflowLedgers: new Map<string, number>(), outflowLedgers: new Map<string, number>() };
            if (x.kind === "inflow") { v.inflow += x.amount; v.inflowLedgers.set(x.ledger, (v.inflowLedgers.get(x.ledger) || 0) + x.amount); }
            else { v.outflow += x.amount; v.outflowLedgers.set(x.ledger, (v.outflowLedgers.get(x.ledger) || 0) + x.amount); }
            m.set(x.group, v);
            return m;
          },
          new Map<string, { group: string; inflow: number; outflow: number; inflowLedgers: Map<string, number>; outflowLedgers: Map<string, number> }>()
        )
        .values(),
    ]
      .map((g) => ({
        ...g,
        inflowLedgers: [...g.inflowLedgers.entries()].map(([name, amount]) => ({ name, amount })).sort((a, b) => a.name.localeCompare(b.name)),
        outflowLedgers: [...g.outflowLedgers.entries()].map(([name, amount]) => ({ name, amount })).sort((a, b) => a.name.localeCompare(b.name)),
      }))
      .sort((a, b) => a.group.localeCompare(b.group));
    return { cashFlowItems: items, cashFlowGroups: groups };
  }, [data, calc]);

  const adjustedFilteredRows = useMemo(() => {
    if (!data) return [];
    const tol = 0.005;
    const masterGroups = new Map((data.groups || []).map((g) => [g.name.toLowerCase(), g]));
    const natureFor = (a: Account) => {
      const group = (a.parent || "").toLowerCase(), configured = masterGroups.get(group);
      if (group.includes("(asset)")) return "Asset";
      if (configured) return configured.nature;
      if (/^(direct incomes|indirect incomes|sales accounts)$/.test(group)) return "Income";
      if (/^(direct expenses|indirect expenses|purchase accounts)$/.test(group)) return "Expense";
      if (/^(capital account|reserves & surplus)$/.test(group)) return "Capital";
      if (/^(current liabilities|loans \(liability\)|bank od a\/c|secured loans|unsecured loans|duties & taxes|provisions|sundry creditors)$/.test(group)) return "Liability";
      if (group === "bank accounts") return "Bank";
      if (group === "cash-in-hand") return "Cash";
      if (group === "investments") return "Investment";
      return "Asset";
    };
    const isNominalLedgerRow = (a: Account) =>
      year !== "all" && !/profit\s*&\s*loss|income\s*&\s*expenditure/i.test(a.name) && /^(Income|Expense)$/.test(natureFor(a));
    const rows = data.accounts.map((a) => {
      const opening = calc.opening.get(a.id) || 0, debit = calc.debit.get(a.id) || 0,
        credit = calc.credit.get(a.id) || 0, closing = calc.closing.get(a.id) || 0,
        nominal = isNominalLedgerRow(a);
      return { ...a, opening: nominal ? 0 : opening, debit, credit, closing: nominal ? debit - credit : closing };
    });
    const active = rows.filter((a) => Math.abs(a.opening) > tol || a.debit > tol || a.credit > tol || Math.abs(a.closing) > tol);
    const isProfitLoss = (a: typeof rows[number]) => /profit\s*&\s*loss|income\s*&\s*expenditure/i.test(a.name);
    const isIncome = (a: typeof rows[number]) => !isProfitLoss(a) && natureFor(a) === "Income";
    const isExpense = (a: typeof rows[number]) => !isProfitLoss(a) && natureFor(a) === "Expense";
    const selectedPeriod = year !== "all";
    return active
      .map((a) => {
        const nom = (isIncome(a) || isExpense(a)) && selectedPeriod,
          pl = isProfitLoss(a) && selectedPeriod,
          opening = pl || nom ? 0 : a.opening,
          closing = opening - a.debit + a.credit;
        return { ...a, opening, closing };
      })
      .filter((a) => Math.abs(a.opening) > tol || a.debit > tol || a.credit > tol || Math.abs(a.closing) > tol)
      .filter((a) => !tableFilter || `${a.name} ${a.parent || a.category}`.toLowerCase().includes(tableFilter.toLowerCase()))
      .filter((a) => !minAmount || Math.max(Math.abs(a.opening), a.debit, a.credit, Math.abs(a.closing)) >= Number(minAmount))
      .sort((a, b) => {
        const av = sortKey === "name" ? a.name.toLowerCase() : sortKey === "group" ? (a.parent || a.category).toLowerCase() : Number(a[sortKey as "opening" | "debit" | "credit" | "closing"] || 0),
          bv = sortKey === "name" ? b.name.toLowerCase() : sortKey === "group" ? (b.parent || b.category).toLowerCase() : Number(b[sortKey as "opening" | "debit" | "credit" | "closing"] || 0),
          result = typeof av === "string" ? av.localeCompare(String(bv)) : av - Number(bv);
        return sortDir === "asc" ? result : -result;
      });
  }, [data, calc, year, tableFilter, minAmount, sortKey, sortDir]);

  if (!data)
    return (
      <UnlockScreen
        biometricChecked={biometricChecked}
        hasBiometric={hasBiometric}
        showPasswordFallback={showPasswordFallback}
        password={password}
        status={status}
        onPasswordChange={setPassword}
        onPasswordSubmit={unlock}
        onBiometricUnlock={biometricUnlock}
        onShowPasswordFallback={setShowPasswordFallback}
      />
    );

  const fmt = (n: number) =>
      new Intl.NumberFormat(data.currency === "INR" ? "en-IN" : "en-US", {
        style: "currency",
        currency: data.currency || "USD",
      }).format(Math.abs(n) < 0.005 ? 0 : n),
    tol = 0.005,
    years = [
      ...new Set(
        data.transactions
          .filter((t) => !t.deleted)
          .map((t) => {
            const y = Number(t.date.slice(0, 4)),
              m = Number(t.date.slice(5, 7));
            return String(m >= 4 ? y : y - 1);
          })
      ),
    ]
      .sort()
      .reverse(),
    months = [
      ...new Set(data.transactions.filter((t) => !t.deleted).map((t) => t.date.slice(0, 7))),
    ]
      .sort()
      .reverse();

  const nominalNatureForRow = (a: Account) => {
      const group = (a.parent || "").toLowerCase(),
        configured = (data.groups || []).find((g) => g.name.toLowerCase() === group)?.nature;
      if (configured) return configured;
      if (/^(direct incomes|indirect incomes|sales accounts)$/.test(group)) return "Income";
      if (/^(direct expenses|indirect expenses|purchase accounts)$/.test(group)) return "Expense";
      return "";
    },
    isNominalLedgerRow = (a: Account) =>
      year !== "all" &&
      !/profit\s*&\s*loss|income\s*&\s*expenditure/i.test(a.name) &&
      /^(Income|Expense)$/.test(nominalNatureForRow(a));

  const rows = data.accounts.map((a) => {
      const opening = calc.opening.get(a.id) || 0,
        debit = calc.debit.get(a.id) || 0,
        credit = calc.credit.get(a.id) || 0,
        closing = calc.closing.get(a.id) || 0,
        nominal = isNominalLedgerRow(a);
      return {
        ...a,
        opening: nominal ? 0 : opening,
        debit,
        credit,
        closing: nominal ? debit - credit : closing,
      };
    }),
    active = rows.filter(
      (a) =>
        Math.abs(a.opening) > tol || a.debit > tol || a.credit > tol || Math.abs(a.closing) > tol
    ),
    debits = active.reduce((s, a) => s + (a.closing < 0 ? -a.closing : 0), 0),
    credits = active.reduce((s, a) => s + (a.closing > 0 ? a.closing : 0), 0);

  const isCashBank = (a: Account) =>
    /^(bank accounts|cash-in-hand)$/.test((a.parent || "").toLowerCase());

  // Display order for the Cash and Bank Balances breakdown: Credit Cards,
  // then Checking, then Savings, then Charles Schwab last.
  const bankAccountOrderRank = (name: string) => {
    const n = (name || "").toLowerCase();
    if (/charles schwab/.test(n)) return 3;
    if (/credit card/.test(n)) return 0;
    if (/savings/.test(n)) return 2;
    return 1;
  };

  const accountById = new Map(rows.map((a) => [a.id, a]));

  const cashBank = rows.filter(isCashBank).reduce((s, a) => s - a.closing, 0),
    cashIds = new Set(rows.filter(isCashBank).map((a) => a.id)),
    cashOpening = -rows.filter(isCashBank).reduce((s, a) => s + a.opening, 0);


  const
    cashInflows = cashFlowGroups.reduce((s, g) => s + g.inflow, 0),
    cashOutflows = cashFlowGroups.reduce((s, g) => s + g.outflow, 0),
    cashNet = cashInflows - cashOutflows,
    cashFlowClosing = cashOpening + cashNet,
    investmentRows = rows.filter(
      (a) => /^investments$/i.test(a.parent || "") && Math.abs(a.closing) > tol
    ),
    investments = investmentRows.reduce((s, a) => s - a.closing, 0);

  const compact = (label: string, items: typeof rows, pattern: RegExp) => ({
      label,
      value: items.filter((a) => pattern.test(a.name)).reduce((s, a) => s - a.closing, 0),
    }),
    cashHighlights = (
      book === "us"
        ? [
            compact("AMEX", rows, /^AMEX Credit Card$/i),
            compact("BofA", rows, /^Bank Of America$/i),
            compact("Citi", rows, /^Citi Credit Card$/i),
          ]
        : [
            compact("Axis", rows, /^Axis Bank$/i),
            compact("HDFC", rows, /^HDFC Bank - Hiral$/i),
            compact("PPF", rows, /^SBI\s*-\s*PPF Account$/i),
          ]
    ).filter((x) => Math.abs(x.value) > tol),
    investmentHighlights = (
      book === "us"
        ? [
            compact("401K", investmentRows, /^401K Investments$/i),
            compact("ESPP", investmentRows, /^ESPP Deduction$/i),
            compact("Canyon", investmentRows, /Canyon/i),
          ]
        : [compact("LIC", investmentRows, /^LIC\b/i), compact("Max", investmentRows, /^Max\b/i)]
    ).filter((x) => Math.abs(x.value) > tol);

  const masterGroups = new Map((data.groups || []).map((g) => [g.name.toLowerCase(), g])),
    natureFor = (a: (typeof rows)[number]) => {
      const group = (a.parent || "").toLowerCase(),
        configured = masterGroups.get(group);
      if (group.includes("(asset)")) return "Asset";
      if (configured) return configured.nature;
      if (/^(direct incomes|indirect incomes|sales accounts)$/.test(group)) return "Income";
      if (/^(direct expenses|indirect expenses|purchase accounts)$/.test(group)) return "Expense";
      if (/^(capital account|reserves & surplus)$/.test(group)) return "Capital";
      if (
        /^(current liabilities|loans \(liability\)|bank od a\/c|secured loans|unsecured loans|duties & taxes|provisions|sundry creditors)$/.test(
          group
        )
      )
        return "Liability";
      if (group === "bank accounts") return "Bank";
      if (group === "cash-in-hand") return "Cash";
      if (group === "investments") return "Investment";
      return "Asset";
    };

  const isProfitLoss = (a: (typeof rows)[number]) =>
      /profit\s*&\s*loss|income\s*&\s*expenditure/i.test(a.name),
    parentOf = (a: (typeof rows)[number]) => (a.parent || "").toLowerCase(),
    isIncome = (a: (typeof rows)[number]) => !isProfitLoss(a) && natureFor(a) === "Income",
    isExpense = (a: (typeof rows)[number]) => !isProfitLoss(a) && natureFor(a) === "Expense",
    isLiability = (a: (typeof rows)[number]) =>
      !isProfitLoss(a) && ["Liability", "Capital"].includes(natureFor(a)),
    isAsset = (a: (typeof rows)[number]) =>
      !isProfitLoss(a) && ["Asset", "Bank", "Cash", "Investment"].includes(natureFor(a)),
    // Real debt only (loans, credit cards, sundry creditors) -- excludes Capital Account/Reserves
    // & Surplus, which represent accumulated net worth itself rather than money owed to someone
    // else. Used for Net Worth (Assets − real Liabilities), not the accounting-style Balance Sheet
    // (Assets = Liabilities + Capital) which needs both.
    isRealLiability = (a: (typeof rows)[number]) => !isProfitLoss(a) && natureFor(a) === "Liability";

  const incomeRows = active.filter(isIncome),
    expenseRows = active.filter(isExpense),
    periodIncomeRows = incomeRows
      .map((a) => ({ ...a, closing: a.credit - a.debit }))
      .filter((a) => Math.abs(a.closing) > tol),
    periodExpenseRows = expenseRows
      .map((a) => ({ ...a, closing: a.debit - a.credit }))
      .filter((a) => Math.abs(a.closing) > tol),
    assetRows = active.filter((a) => isAsset(a) && Math.abs(a.closing) > tol),
    liabilityRows = active.filter((a) => isLiability(a) && Math.abs(a.closing) > tol),
    realLiabilityRows = active.filter((a) => isRealLiability(a) && Math.abs(a.closing) > tol),
    periodIncome = periodIncomeRows.reduce((s, a) => s + a.closing, 0),
    periodExpense = periodExpenseRows.reduce((s, a) => s + a.closing, 0),
    periodSurplus = periodIncome - periodExpense;

  const latestDate = data.transactions
      .filter((t) => !t.deleted)
      .reduce((m, t) => (t.date > m ? t.date : m), "0000-00-00"),
    balanceEnd =
      year === "all"
        ? latestDate
        : year === "custom"
          ? `${customEnd}-31`
          : year.length === 7
            ? `${year}-31`
            : `${Number(year) + 1}-03-31`,
    balanceFY = fiscalYearOf(balanceEnd),
    balanceFYStart = `${balanceFY}-04-01`,
    nominalIds = new Set(rows.filter((a) => isIncome(a) || isExpense(a)).map((a) => a.id));

  // Vested RSU/ESPP shares still held have real market value but aren't booked in the ledger
  // (nothing to double-entry until sold) -- Net Worth adds them as an extra asset row so they're
  // not silently missing from the total. Priced as of the selected period's end date: today's
  // live price if that date hasn't happened yet (or is today), otherwise the actual historical
  // closing price on that date -- so switching the Financial period dropdown shows what the
  // equity was actually worth then, not today's value re-applied to every year.
  const todayStr = new Date().toISOString().slice(0, 10);
  const priceForDate = (d: string) => (d >= todayStr ? nvdaPrice ?? null : priceAsOf(nvdaHistory, d));
  const balanceEndPrice = priceForDate(balanceEnd);
  const heldEquity =
    data.equity && balanceEndPrice
      ? computeHeldEquityValueAsOf(data.equity.grants, data.equity.esppPurchases, balanceEnd, balanceEndPrice)
      : { rsuValue: 0, esppValue: 0, totalValue: 0 };
  // 401(k)/IRA: value at live market balance instead of the ledger's book value (cumulative
  // payroll contributions never include employer match or investment growth/loss) -- drop the
  // real "401K Investments" ledger row and substitute a synthetic one at the live figure, same
  // "book value vs. real value" gap already called out on the Retirement tab. Falls back to the
  // ledger row as-is if the live balance hasn't loaded (never silently drops the asset to $0).
  const assetRowsForNetWorth = liveRetirementBalance != null
    ? assetRows.filter((a) => a.name !== "401K Investments")
    : assetRows;
  const netWorthAssetRowsBase =
    liveRetirementBalance != null
      ? [...assetRowsForNetWorth, retirementLiveRow("retirement-live", liveRetirementBalance)]
      : assetRowsForNetWorth;
  const netWorthAssetRows =
    heldEquity.totalValue > 0 ? [...netWorthAssetRowsBase, equityHoldingsRow("equity-holdings", heldEquity.totalValue)] : netWorthAssetRowsBase;
  // Trend: each fiscal year-end point is valued at that year's own closing price (not today's),
  // so the chart reflects actual historical equity value, not a flat bump on the latest point.
  const netWorthTrendWithEquity = data.equity
    ? netWorthTrend.map((p) => {
        const price = priceForDate(p.fyEndDate);
        const val = price
          ? computeHeldEquityValueAsOf(data.equity!.grants, data.equity!.esppPurchases, p.fyEndDate, price).totalValue
          : 0;
        return val > 0 ? { ...p, assets: p.assets + val, netWorth: p.netWorth + val } : p;
      })
    : netWorthTrend;

  let capitalTransfer = 0;
  for (const t of data.transactions)
    if (!t.deleted && !t.cancelled && t.date >= balanceFYStart && t.date <= balanceEnd)
      for (const e of t.entries) if (nominalIds.has(e.accountId)) capitalTransfer += e.amount;

  // Tally Day Book order: Date ascending, then Voucher Type in Tally's default
  // sequence (Contra, Payment, Receipt, Journal), then Voucher Number ascending.
  const VOUCHER_TYPE_ORDER: Record<string, number> = { contra: 0, payment: 1, receipt: 2, journal: 3 };
  const voucherTypeRank = (type: string) => VOUCHER_TYPE_ORDER[(type || "").toLowerCase()] ?? 99;
  const voucherNumRank = (num: string) => {
    const n = Number(num);
    return Number.isFinite(n) ? n : Infinity;
  };
  const filteredAll = calc.period
    .filter(
      (t) =>
        !query ||
        `${t.date} ${t.number} ${t.type} ${t.narration} ${t.entries.map((e) => e.accountName).join(" ")}`
          .toLowerCase()
          .includes(query.toLowerCase())
    )
    .slice()
    .sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      const ta = voucherTypeRank(a.type), tb = voucherTypeRank(b.type);
      if (ta !== tb) return ta - tb;
      return voucherNumRank(a.number) - voucherNumRank(b.number);
    });
  const DAY_BOOK_CAP = 750;
  // filteredAll is oldest-first (Tally order) — cap keeps the most recent entries by default
  // (large tables render slowly), but showAllVouchers lets the user opt into the full list.
  const dayBookCapped = filteredAll.length > DAY_BOOK_CAP;
  const filtered = showAllVouchers || !dayBookCapped ? filteredAll : filteredAll.slice(-DAY_BOOK_CAP);

  const selectedRow = rows.find((a) => a.id === selected),
    selectedTx = selected
      ? calc.period
          .filter((t) => t.entries.some((e) => e.accountId === selected))
          .slice()
          .reverse()
      : [];

  async function createLedgerInsideVoucher(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!data) return;
    if (!inlineLedgerSide) return;
    const form = new FormData(e.currentTarget),
      name = String(form.get("name") || "")
        .trim()
        .replace(/\s+/g, " "),
      parent = String(form.get("parent") || ""),
      currency = String(form.get("currency") || data.currency),
      amount = Math.abs(Number(form.get("opening") || 0)),
      side = String(form.get("side") || "Dr");
    if (!name || !parent) {
      setStatus("Enter a ledger name and select its account group.");
      return;
    }
    if (data.accounts.some((a) => a.name.toLowerCase() === name.toLowerCase())) {
      setStatus(`Ledger ${name} already exists. Select it from the voucher instead.`);
      return;
    }
    const nature =
        (data.groups || []).find((g) => g.name === parent)?.nature ||
        (/^bank accounts$/i.test(parent)
          ? "Bank"
          : /^cash-in-hand$/i.test(parent)
            ? "Cash"
            : /^investments$/i.test(parent)
              ? "Investment"
              : /income/i.test(parent)
                ? "Income"
                : /expense|purchase/i.test(parent)
                  ? "Expense"
                  : /capital/i.test(parent)
                    ? "Capital"
                    : /liabilit|creditor|loan/i.test(parent)
                      ? "Liability"
                      : "Asset"),
      id = Math.max(0, ...data.accounts.map((a) => a.id)) + 1,
      account: Account = {
        id,
        name,
        parent,
        category: nature,
        currency,
        openingBalance: side === "Dr" ? -amount : amount,
        active: true,
        masterSyncStatus: "pending",
        masterFingerprint: "app-change-" + Date.now(),
      },
      next = { ...data, accounts: [...data.accounts, account] };
    if (!(await save(next, "new"))) return;
    setInlineLedgerSide(null);
    setStatus(
      `Created ledger ${name}. It is selected for this voucher and pending Tally synchronization.`
    );
    setVoucherLines((lines) => [
      ...lines,
      { id: crypto.randomUUID(), side: inlineLedgerSide, accountId: String(id), amount: "" },
    ]);
  }

  function editVoucher(t: Tx) {
    if (t.cancelled) {
      setStatus("Cancelled vouchers are audit-only and cannot be edited.");
      return;
    }
    if (!t.entries.some((e) => e.amount < 0) || !t.entries.some((e) => e.amount > 0)) {
      setStatus("This voucher does not contain both debit and credit lines.");
      return;
    }
    setVoucherLines(draftLinesFromTx(t));
    setEditTx(t);
    setCopyTx(null);
    setSelected(null);
    setTab("new");
    setStatus("Editing existing voucher. Review changes carefully before updating.");
  }

  function copyVoucher(t: Tx) {
    if (!t.entries.some((e) => e.amount < 0) || !t.entries.some((e) => e.amount > 0)) {
      setStatus("This voucher does not contain both debit and credit lines.");
      return;
    }
    setVoucherLines(draftLinesFromTx(t));
    setCopyTx(t);
    setEditTx(null);
    setSelected(null);
    setTab("new");
    setStatus(
      "Voucher copied with all ledger lines. Change any field, then save as a new voucher."
    );
  }

  function deleteVoucher(t: Tx) {
    if (!data) return;
    if (!confirm(`Permanently delete ${t.type} voucher ${t.number} from both the app and Tally?`))
      return;
    if (!t.tallyGuid && !t.syncFingerprint) {
      void save({ ...data, transactions: data.transactions.filter((x) => x.guid !== t.guid) });
      setStatus(`Voucher ${t.number} deleted.`);
      return;
    }
    const deleted = { ...t, deleted: true, syncStatus: "pending", lastSyncedAt: undefined };
    void save({
      ...data,
      transactions: data.transactions.map((x) => (x.guid === t.guid ? deleted : x)),
    });
    setStatus(
      `Voucher ${t.number} removed from the app. It will be deleted from Tally automatically.`
    );
  }

  async function add(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!data) return;
    const f = new FormData(e.currentTarget),
      byId = new Map(data.accounts.map((a) => [a.id, a.name])),
      entries = voucherLines
        .map((line) => {
          const accountId = Number(line.accountId),
            amount = Math.abs(Number(line.amount || 0));
          return {
            accountId,
            accountName: byId.get(accountId) || "",
            amount: line.side === "debit" ? -amount : amount,
          };
        })
        .filter((e) => e.accountId && centsOf(e.amount) !== 0),
      debitTotal = entries.filter((e) => e.amount < 0).reduce((s, e) => s - e.amount, 0),
      creditTotal = entries.filter((e) => e.amount > 0).reduce((s, e) => s + e.amount, 0);
    if (entries.length < 2) {
      setStatus("Enter at least two voucher lines.");
      return;
    }
    if (!debitTotal || !creditTotal) {
      setStatus("Voucher must contain both debit and credit lines.");
      return;
    }
    if (centsOf(debitTotal) !== centsOf(creditTotal)) {
      setStatus("Debit total and credit total must be equal.");
      return;
    }
    const type = String(f.get("type")),
      date = String(f.get("date"));
    const tx: Tx = {
      id: editTx?.id || nextTransactionIds(data.transactions, 1)[0],
      guid: editTx?.guid || crypto.randomUUID(),
      ...(editTx
        ? {
            tallyGuid: editTx.tallyGuid,
            syncFingerprint: editTx.syncFingerprint || `app-change-${Date.now()}`,
            lastSyncedAt: undefined,
            createdAt: editTx.createdAt,  // preserve original creation time on edits
          }
        : { createdAt: new Date().toISOString() }),
      syncStatus: "pending",
      date,
      number:
        editTx && editTx.type === type && fiscalYearOf(editTx.date) === fiscalYearOf(date)
          ? editTx.number
          : nextVoucherNumber(data, type, date, editTx?.guid),
      type,
      narration: String(f.get("narration") || ""),
      historical: editTx?.historical || false,
      cancelled: editTx?.cancelled || false,
      entries,
    };
    const validation = validateVoucher(tx, data.accounts);
    if (!validation.valid) {
      setStatus(validation.errors.join(" "));
      return;
    }
    const nextTransactions = editTx
      ? data.transactions.map((t) => (t.guid === editTx.guid ? tx : t))
      : [...data.transactions, tx];
    if (await save({ ...data, transactions: nextTransactions })) {
      setCopyTx(null);
      setEditTx(null);
      setVoucherLines(blankVoucherLines());
    }
  }

  const voucherDebitDraftTotal = voucherLines
      .filter((l) => l.side === "debit")
      .reduce((s, l) => s + Math.abs(Number(l.amount || 0)), 0),
    voucherCreditDraftTotal = voucherLines
      .filter((l) => l.side === "credit")
      .reduce((s, l) => s + Math.abs(Number(l.amount || 0)), 0);

  const capitalRows = active.filter(
      (a) =>
        parentOf(a) === "capital account" &&
        (Math.abs(a.opening) > tol || Math.abs(a.closing) > tol)
    ),
    capitalClosing = capitalRows.reduce((s, a) => s + a.closing, 0),
    capitalOpening = capitalRows.reduce((s, a) => s + a.opening, 0),
    dashboardCapitalBase = year === "all" ? capitalOpening : capitalClosing,
    dashboardCapitalResult =
      year === "all"
        ? periodSurplus
        : year === "custom" || year.length === 7
          ? periodSurplus
          : capitalTransfer,
    dashboardCapitalTotal = dashboardCapitalBase + dashboardCapitalResult,
    capitalHighlights = [
      { label: "Capital", value: dashboardCapitalBase },
      { label: "RE", value: dashboardCapitalResult },
    ];

  const salaryDetail = rows
      .filter((a) => /salary/i.test(a.name))
      .map((a) => ({ ...a, closing: a.credit - a.debit }))
      .filter((a) => Math.abs(a.closing) > tol),
    salaryIncome = salaryDetail.reduce((s, a) => s + a.closing, 0),
    salaryHighlights = salaryDetail
      .filter((a) => Math.abs(a.closing) > tol)
      .slice()
      .sort((a, b) => b.closing - a.closing)
      .slice(0, 3)
      .map((a) => ({
        label: a.name.replace(/^salary(?: income)?\s*-\s*/i, "") || a.name,
        value: a.closing,
      }));

  const totalIncomeDetail = rows
    .filter(a =>
      /^(direct incomes|indirect incomes|sales accounts)$/i.test((a.parent || "").toLowerCase()) &&
      !/profit\s*&\s*loss|income\s*&\s*expenditure/i.test(a.name)
    )
    .map(a => ({ ...a, incomeAmt: a.credit - a.debit }))
    .filter(a => a.incomeAmt > tol)
    .sort((a, b) => b.incomeAmt - a.incomeAmt);
  const totalIncome = totalIncomeDetail.reduce((s, a) => s + a.incomeAmt, 0);
  const totalIncomeHighlights = totalIncomeDetail
    .slice(0, 3)
    .map(a => ({ label: a.name, value: a.incomeAmt }));

  const cur = nvdaPrice ?? 0;
  const equityRsuMktValue = (data?.equity?.grants ?? []).reduce((s, g) => {
    const actualVested = g.vests.filter(v => !v.pending);
    const pendingVests = g.vests.filter(v => v.pending);
    const vestedTotal = actualVested.reduce((vs, v) => vs + v.shares, 0);
    const pendingShares = pendingVests.reduce((vs, v) => vs + v.shares, 0);
    const unvested = Math.max(0, g.totalShares - vestedTotal - pendingShares);
    return s + actualVested.reduce((vs, v) => vs + v.sharesHeld * cur, 0) + (pendingShares + unvested) * cur;
  }, 0);
  const equityEsppMktValue = (data?.equity?.esppPurchases ?? []).reduce(
    (s, e) => s + (e.sharesHeld || e.shares) * cur,
    0
  );
  const equityMktValue = equityRsuMktValue + equityEsppMktValue;
  // Held vested RSU at live price (excludes scheduled/unvested)
  const equityRsuVestedValue = (data?.equity?.grants ?? []).reduce(
    (s, g) => s + g.vests.filter(v => !v.pending).reduce((vs, v) => vs + v.sharesHeld * cur, 0),
    0
  );
  // Scheduled future vests per grant (for dashboard chips)
  const equityScheduledGrants = (data?.equity?.grants ?? [])
    .map(g => {
      const sh = g.vests.filter(v => v.pending).reduce((vs, v) => vs + v.shares, 0);
      return { grantDate: g.grantDate, scheduledShares: sh };
    })
    .filter(g => g.scheduledShares > 0);
  const equityScheduledShares = equityScheduledGrants.reduce((s, g) => s + g.scheduledShares, 0);
  const equityScheduledValue = equityScheduledShares * cur;
  // Daily G/(L): held (non-pending) RSU + ESPP shares × (live − prev close)
  const equityDailyHeld = (data?.equity?.grants ?? []).reduce(
    (s, g) => s + g.vests.filter(v => !v.pending).reduce((vs, v) => vs + v.sharesHeld, 0), 0
  ) + (data?.equity?.esppPurchases ?? []).reduce((s, e) => s + (e.sharesHeld || e.shares), 0);
  const equityDailyGL = (cur > 0 && nvdaPrevClose !== null) ? equityDailyHeld * (cur - nvdaPrevClose) : null;
  const fmtGrantDate = (iso: string) => { const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}-${m[2]}-${m[1]}` : iso; };

  const filteredActive = active
    .filter(
      (a) =>
        !tableFilter ||
        `${a.name} ${a.parent || a.category}`.toLowerCase().includes(tableFilter.toLowerCase())
    )
    .filter(
      (a) =>
        !minAmount ||
        Math.max(Math.abs(a.opening), a.debit, a.credit, Math.abs(a.closing)) >= Number(minAmount)
    )
    .sort((a, b) => {
      const av =
          sortKey === "name"
            ? a.name.toLowerCase()
            : sortKey === "group"
              ? (a.parent || a.category).toLowerCase()
              : Number(a[sortKey as "opening" | "debit" | "credit" | "closing"] || 0),
        bv =
          sortKey === "name"
            ? b.name.toLowerCase()
            : sortKey === "group"
              ? (b.parent || b.category).toLowerCase()
              : Number(b[sortKey as "opening" | "debit" | "credit" | "closing"] || 0),
        result = typeof av === "string" ? av.localeCompare(String(bv)) : av - Number(bv);
      return sortDir === "asc" ? result : -result;
    });


  const sortBy = (key: string) => {
    if (sortKey === key) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const SortHead = ({
    field,
    children,
    right = false,
  }: {
    field: string;
    children: React.ReactNode;
    right?: boolean;
  }) => (
    <th className={`${right ? "right " : ""}sortable`}>
      <button onClick={() => sortBy(field)}>
        {children}
        <span
          className="sort-mark"
          data-direction={sortKey === field ? sortDir : "none"}
          aria-hidden="true"
        />
      </button>
    </th>
  );

  const tableFiltersJsx = (
    <div className="table-filters">
      <label>
        Filter ledger or group
        <input
          value={tableFilter}
          onChange={(e) => setTableFilter(e.target.value)}
          placeholder="Type to filter..."
        />
      </label>
      <label>
        Minimum absolute value
        <input
          type="number"
          min="0"
          step="0.01"
          value={minAmount}
          onChange={(e) => setMinAmount(e.target.value)}
          placeholder="Any amount"
        />
      </label>
      <button
        onClick={() => {
          setTableFilter("");
          setMinAmount("");
          setSortKey("name");
          setSortDir("asc");
        }}
      >
        Clear
      </button>
      <span>
        {adjustedFilteredRows.length} of {active.length} ledgers
      </span>
    </div>
  );

  const periodLabel =
    year === "all"
      ? "All periods"
      : year === "custom"
        ? `${new Date(`${customStart}-01T00:00:00`).toLocaleDateString("en-US", { month: "short", year: "numeric" })} to ${new Date(`${customEnd}-01T00:00:00`).toLocaleDateString("en-US", { month: "short", year: "numeric" })}`
        : year.length === 7
          ? new Date(`${year}-01T00:00:00`).toLocaleDateString("en-US", {
              month: "long",
              year: "numeric",
            })
          : `FY ${year} (Apr ${year} - Mar ${Number(year) + 1})`;

  const PeriodSelect = () => (
    <span className="period-select-inline">
      <select value={year} onChange={(e) => setYear(e.target.value)}>
        <option value="all">All periods</option>
        <option value="custom">Custom range</option>
        <optgroup label="Fiscal years">
          {years.map((y) => (
            <option value={y} key={y}>
              FY {y}
            </option>
          ))}
        </optgroup>
        <optgroup label="Month">
          {months.map((m) => (
            <option value={m} key={m}>
              {new Date(`${m}-01T00:00:00`).toLocaleDateString("en-US", {
                month: "short",
                year: "numeric",
              })}
            </option>
          ))}
        </optgroup>
      </select>
      {year === "custom" && (
        <>
          <input
            type="month"
            value={customStart}
            max={customEnd}
            onChange={(e) => setCustomStart(e.target.value)}
          />
          <span>–</span>
          <input
            type="month"
            value={customEnd}
            min={customStart}
            onChange={(e) => setCustomEnd(e.target.value)}
          />
        </>
      )}
    </span>
  );

  const LedgerLink = ({ a }: { a: { id: number; name: string } }) => (
    <button className="ledger-link" onClick={() => setSelected(a.id)}>
      {a.name}
    </button>
  );

  const startNewVoucher = (type?: string) => {
    setEditTx(null);
    setCopyTx(null);
    setSelected(null);
    setSelectedVoucher(null);
    setNewVoucherType(type || null);
    setNewVoucherMenuOpen(false);
    setTab("new");
    setStatus("");
  };

  const toggleDashboardDetail = (
    kind: "cash" | "investments" | "capital" | "salary" | "active" | "period"
  ) => setDashboardDetail((current) => (current === kind ? null : kind));

  const DashboardInline = ({
    kind,
  }: {
    kind: "cash" | "investments" | "capital" | "salary" | "active" | "period";
  }) => {
    if (dashboardDetail !== kind) return null;
    const titles = {
      cash: "Cash and Bank Balances",
      investments: "Investment Ledgers",
      capital: "Capital Account Composition",
      salary: `Salary Income - ${periodLabel}`,
      active: "Active Ledgers",
      period: `Period Vouchers - ${periodLabel}`,
    };
    const detailRows =
      kind === "cash"
        ? (() => {
            const cashRows = rows.filter((a) => isCashBank(a) && Math.abs(a.closing) > tol);
            return book === "us"
              ? [...cashRows].sort((a, b) => bankAccountOrderRank(a.name) - bankAccountOrderRank(b.name))
              : cashRows;
          })()
        : kind === "investments"
          ? active.filter((a) => /^investments$/i.test(a.parent || "") && Math.abs(a.closing) > tol)
          : kind === "capital"
            ? capitalRows
            : kind === "salary"
              ? salaryDetail
              : kind === "active"
                ? [...active].sort((a, b) => Math.abs(b.closing) - Math.abs(a.closing))
                : [];
    return (
      <div className="dashboard-inline-detail">
        <div className="dashboard-inline-heading">
          <strong>{titles[kind]}</strong>
          <small>Tap card again to close</small>
        </div>
        {kind === "period" ? (
          calc.period
            .slice()
            .reverse()
            .slice(0, 20)
            .map((t) => (
              <button
                type="button"
                className="dashboard-inline-row dashboard-inline-button"
                key={t.guid}
                onClick={() => setSelectedVoucher(t)}
              >
                <span>
                  {formatVoucherDisplayDate(t.date)} | {cleanVoucherDisplay(t.type)} {t.number}
                  <small className="period-voucher-meta">
                    <span>Dr: {voucherSideLedgerNames(t, "dr") || "-"}</span>
                    <span>Cr: {voucherSideLedgerNames(t, "cr") || "-"}</span>
                    <span>{cleanVoucherDisplay(t.narration) || "-"}</span>
                  </small>
                </span>
                <b>{fmt(Math.max(...t.entries.map((e) => Math.abs(e.amount)), 0))}</b>
              </button>
            ))
        ) : (
          <>
            {detailRows.slice(0, 20).map((a) => (
              <button
                type="button"
                className="dashboard-inline-row dashboard-inline-button"
                key={a.id}
                onClick={() => setSelected(a.id)}
              >
                <span>
                  {a.name}
                  <small>{a.parent || a.category}</small>
                </span>
                <b>{fmt(kind === "cash" || kind === "investments" ? -a.closing : a.closing)}</b>
              </button>
            ))}
            {kind === "capital" && (
              <button
                type="button"
                className="dashboard-inline-row dashboard-inline-button current-result"
                onClick={() => {
                  setDashboardDetail(null);
                  setReport("income");
                  setTab("reports");
                }}
              >
                <span>
                  {year === "custom" || year.length === 7
                    ? "Selected-period"
                    : "Current fiscal-year"}{" "}
                  surplus / (deficit)
                </span>
                <b>{fmt(dashboardCapitalResult)}</b>
              </button>
            )}
          </>
        )}
      </div>
    );
  };

  const syncStatusText = (value: unknown) =>
    String(value ?? "")
      .trim()
      .toLowerCase();
  const syncValues = (item: Record<string, unknown>) =>
    [
      item.syncStatus,
      item.masterSyncStatus,
      item.tallySyncStatus,
      item.appToTallyStatus,
      item.tallyToAppStatus,
      item.syncResult,
      item.syncError,
      item.lastSyncError,
    ].filter((value) => value !== undefined && value !== null && String(value).trim() !== "");
  const syncFieldError = (value: unknown) => {
    const text = syncStatusText(value);
    return (
      text === "2" ||
      text === "-1" ||
      /error|fail|exception|conflict|blocked|invalid|denied/.test(text)
    );
  };
  const syncFieldPending = (value: unknown) => {
    const text = syncStatusText(value);
    return (
      text === "1" ||
      /pending|queued?|waiting|unsynced|not synced|retry|in[-_ ]?progress|syncing/.test(text)
    );
  };

  const syncTransactions = data.transactions as unknown[],
    syncAccounts = data.accounts as unknown[],
    syncGroups = Array.isArray((data as { groups?: unknown[] }).groups)
      ? (data as { groups: unknown[] }).groups
      : [];

  const togglePrivacy = () =>
    setPrivacyMode((p) => {
      const next = !p;
      localStorage.setItem("dk-privacy", next ? "1" : "0");
      return next;
    });

  const toggleUiTheme = () =>
    setUiTheme((t) => {
      const next = t === "refresh" ? "classic" : "refresh";
      localStorage.setItem("dk-ui-theme", next);
      return next;
    });

  return (
    <div className={[privacyMode ? "privacy-mode" : "", uiTheme === "refresh" ? "ui-refresh" : ""].filter(Boolean).join(" ") || undefined}>
      <header>
        <div>
          <small>FINTECH BY DK - ACCOUNTING RELEASE 5</small>
          <div className="book-heading">
            <h1>Dignesh Khatri</h1>
            <span className={`book-badge ${book}`}>
              {book === "india" ? "INDIA BOOKS | INR" : "US BOOKS | USD"}
            </span>
          </div>
          <p>
            {active.length} active ledgers | {calc.period.length} vouchers in selected period
          </p>
        </div>
        <div className="header-actions">
          {status && (
            <span className={`vault-status${status.startsWith("Auto-fixed") ? " vault-status--info" : ""}`}>
              {status}
            </span>
          )}
          {hasBiometric ? (
            <button
              className="secure-action biometric-action biometric-action--on"
              aria-label="Remove biometric"
              title="Remove biometric"
              onClick={removeBiometric}
            >
              <span className="secure-icon" aria-hidden="true" />
            </button>
          ) : (
            <button
              className="secure-action biometric-action biometric-action--off"
              aria-label="Enable biometric"
              title="Enable biometric"
              onClick={enableBiometric}
            >
              <span className="secure-icon" aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            className={`ui-theme-toggle-button ${uiTheme === "refresh" ? "on" : "off"}`}
            onClick={toggleUiTheme}
            title={uiTheme === "refresh" ? "Switch to classic look" : "Try the new look"}
            aria-label={uiTheme === "refresh" ? "Switch to classic look" : "Try the new look"}
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
              <circle cx="12" cy="12" r="4" />
            </svg>
          </button>
          <button
            type="button"
            className={`privacy-toggle-button ${privacyMode ? "on" : "off"}`}
            onClick={togglePrivacy}
            title={privacyMode ? "Show amounts" : "Hide amounts"}
            aria-label={privacyMode ? "Show amounts" : "Hide amounts"}
          >
            {privacyMode ? (
              <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
                <line x1="1" y1="1" x2="23" y2="23"/>
              </svg>
            ) : (
              <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                <circle cx="12" cy="12" r="3"/>
              </svg>
            )}
          </button>
          <SyncStatusLock book={book} onClick={lockVault} />
        </div>
      </header>
      <div className="app-nav">
        <button
          className={tab === "dashboard" ? "selected" : ""}
          onClick={() => setTab("dashboard")}
        >
          Dashboard
        </button>
        <button className={tab === "daybook" ? "selected" : ""} onClick={() => setTab("daybook")}>
          Day Book
        </button>
        {book !== "india" && (
          <button className={tab === "bank-import" ? "selected" : ""} onClick={() => setTab("bank-import")}>
            Import
          </button>
        )}
        <button className={tab === "reports" ? "selected" : ""} onClick={() => setTab("reports")}>
          Reports
        </button>
        <button className={tab === "masters" ? "selected" : ""} onClick={() => setTab("masters")}>
          Masters
        </button>
        <button className={tab === "ledgers" ? "selected" : ""} onClick={() => setTab("ledgers")}>
          Ledgers
        </button>
        {/* Anomalies tab hidden — ask Claude to re-enable when needed */}
      </div>
      <div className="period-bar">
        <strong>Financial period</strong>
        <select value={year} onChange={(e) => setYear(e.target.value)}>
          <option value="all">All periods</option>
          <option value="custom">Custom month range</option>
          <optgroup label="Fiscal years (April to March)">
            {years.map((y) => (
              <option value={y} key={y}>
                FY {y} (Apr {y} - Mar {Number(y) + 1})
              </option>
            ))}
          </optgroup>
          <optgroup label="Month and year">
            {months.map((m) => (
              <option value={m} key={m}>
                {new Date(`${m}-01T00:00:00`).toLocaleDateString("en-US", {
                  month: "long",
                  year: "numeric",
                })}
              </option>
            ))}
          </optgroup>
        </select>
        {year === "custom" && (
          <div className="custom-range">
            <label>
              From
              <input
                type="month"
                value={customStart}
                max={customEnd}
                onChange={(e) => setCustomStart(e.target.value)}
              />
            </label>
            <span>to</span>
            <label>
              To
              <input
                type="month"
                value={customEnd}
                min={customStart}
                onChange={(e) => setCustomEnd(e.target.value)}
              />
            </label>
          </div>
        )}
        <div className="period-bar-footer">
          <span className="period-bar-note">Opening + period activity = closing</span>
          <div className="new-voucher-fab-wrap" ref={newVoucherMenuRef}>
            <button
              type="button"
              className={`new-voucher-fab ${book === "india" ? "new-voucher-fab-india" : "new-voucher-fab-us"} ${newVoucherMenuOpen ? "menu-open" : ""} ${tab === "new" ? "selected" : ""}`}
              onClick={() => setNewVoucherMenuOpen((o) => !o)}
              title="New Voucher"
              aria-label="New Voucher"
            >
              +
            </button>
            {newVoucherMenuOpen && (
              <>
                <div className="new-voucher-fab-backdrop" onClick={() => setNewVoucherMenuOpen(false)} />
                <div className="new-voucher-fab-menu">
                  {(data.voucherTypes || ["Payment", "Receipt", "Contra", "Journal"]).map((v) => (
                    <button key={v} type="button" onClick={() => startNewVoucher(v)}>
                      <span>{v}</span>
                      <em>{voucherTypeIcon(v)}</em>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
      {tab === "dashboard" && (
        <section className="stats dashboard-stats">
          <div className="dashboard-card-slot cash-slot">
            <button
              className={`dashboard-balance-card cash-card${dashboardDetail === "cash" ? " dashboard-card-open" : ""}`}
              onClick={() => toggleDashboardDetail("cash")}
            >
              {uiTheme === "refresh" && <StatIcon kind="cash" color="#1e40af" />}
              <div className="dashboard-card-main">
                <span>Cash and bank closing</span>
                <strong>{fmt(cashBank)}</strong>
                <small>View account breakdown</small>
              </div>
              <div className="dashboard-card-highlights">
                {cashHighlights.map((x) => (
                  <span key={x.label}>
                    <b>{x.label}</b>
                    <em>{fmt(x.value)}</em>
                  </span>
                ))}
              </div>
            </button>
            <DashboardInline kind="cash" />
          </div>
          <div className="dashboard-card-slot investment-slot">
            <button
              className={`dashboard-balance-card investment-card${dashboardDetail === "investments" ? " dashboard-card-open" : ""}`}
              onClick={() => toggleDashboardDetail("investments")}
            >
              {uiTheme === "refresh" && <StatIcon kind="trending-up" color="#16a34a" />}
              <div className="dashboard-card-main">
                <span>Investments closing</span>
                <strong>{fmt(investments)}</strong>
                <small>View investment ledgers</small>
              </div>
              <div className="dashboard-card-highlights">
                {investmentHighlights.map((x) => (
                  <span key={x.label}>
                    <b>{x.label}</b>
                    <em>{fmt(x.value)}</em>
                  </span>
                ))}
              </div>
            </button>
            <DashboardInline kind="investments" />
          </div>
          <div className="dashboard-card-slot capital-slot">
            <button
              className={`dashboard-balance-card capital-card${dashboardDetail === "capital" ? " dashboard-card-open" : ""}`}
              onClick={() => toggleDashboardDetail("capital")}
            >
              {uiTheme === "refresh" && <StatIcon kind="scale" color="#7c3aed" />}
              <div className="dashboard-card-main">
                <span>Capital closing</span>
                <strong>{fmt(dashboardCapitalTotal)}</strong>
                <small>Includes current result</small>
              </div>
              <div className="dashboard-card-highlights capital-highlights">
                {capitalHighlights.map((x) => (
                  <span key={x.label}>
                    <b>{x.label}</b>
                    <em>{fmt(x.value)}</em>
                  </span>
                ))}
              </div>
            </button>
            <DashboardInline kind="capital" />
          </div>
          <div className="dashboard-card-slot salary-slot">
            <button
              className={`dashboard-balance-card salary-card${dashboardDetail === "salary" ? " dashboard-card-open" : ""}`}
              onClick={() => toggleDashboardDetail("salary")}
            >
              {uiTheme === "refresh" && <StatIcon kind="wallet" color="#d97706" />}
              <div className="dashboard-card-main">
                <span>{book === "india" ? "Total income" : "Salary income"}</span>
                <strong>{fmt(book === "india" ? totalIncome : salaryIncome)}</strong>
                <small>{periodLabel}</small>
              </div>
              <div className="dashboard-card-highlights salary-highlights">
                {(book === "india" ? totalIncomeHighlights : salaryHighlights).map((x) => (
                  <span key={x.label}>
                    <b title={x.label}>{x.label}</b>
                    <em>{fmt(x.value)}</em>
                  </span>
                ))}
              </div>
            </button>
            <DashboardInline kind="salary" />
          </div>
          <div className="dashboard-card-slot active-slot">
            <button
              className={`dashboard-balance-card dashboard-card-active fixed-assets-card${dashboardDetail === "fixedAssets" ? " dashboard-card-open" : ""}`}
              onClick={() =>
                setDashboardDetail(dashboardDetail === "fixedAssets" ? null : "fixedAssets")
              }
            >
              {uiTheme === "refresh" && <StatIcon kind="bank" color="#0891b2" />}
              <div className="dashboard-card-main">
                <span>Fixed assets closing</span>
                <strong>
                  {fmt(
                    rows
                      .filter((a) => /^fixed assets$/i.test(a.parent || ""))
                      .reduce((s, a) => s + displayLedgerBalance(a, a.closing), 0)
                  )}
                </strong>
                <small>View fixed asset ledgers</small>
              </div>
              <div className="dashboard-card-highlights fixed-asset-highlights">
                {rows
                  .filter(
                    (a) =>
                      /^fixed assets$/i.test(a.parent || "") &&
                      !(book === "us" && /home mortgage/i.test(a.name)) &&
                      Math.abs(a.closing) > tol
                  )
                  .slice()
                  .sort(
                    (a, b) =>
                      displayLedgerBalance(b, b.closing) - displayLedgerBalance(a, a.closing)
                  )
                  .slice(0, 3)
                  .map((a) => (
                    <span key={a.id}>
                      <b>
                        {a.name
                          .replace(/\s*-\s*/g, " ")
                          .replace(/\b(fixed assets?|purchase)\b/gi, "")
                          .trim()
                          .slice(0, 12) || "Asset"}
                      </b>
                      <em>{fmt(displayLedgerBalance(a, a.closing))}</em>
                    </span>
                  ))}
              </div>
            </button>
            {dashboardDetail === "fixedAssets" && (
              <div className="dashboard-inline-detail">
                <div className="dashboard-inline-heading">
                  <div>
                    <strong>Fixed Asset Ledgers</strong>
                    <small>Tap card again to close</small>
                  </div>
                </div>
                {rows
                  .filter(
                    (a) =>
                      /^fixed assets$/i.test(a.parent || "") &&
                      Math.abs(displayLedgerBalance(a, a.closing)) > tol
                  )
                  .slice()
                  .sort(
                    (a, b) =>
                      displayLedgerBalance(b, b.closing) - displayLedgerBalance(a, a.closing)
                  )
                  .map((a) => (
                    <button
                      className="dashboard-inline-row dashboard-inline-button"
                      key={a.id}
                      onClick={() => setSelected(a.id)}
                    >
                      <span>
                        {a.name}
                        <small>{a.parent || a.category}</small>
                      </span>
                      <b>{fmt(displayLedgerBalance(a, a.closing))}</b>
                    </button>
                  ))}
              </div>
            )}
            <DashboardInline kind="active" />
          </div>
          {book === "india" && (
            <div className="dashboard-card-slot period-slot">
              <button
                className={`dashboard-card-period${dashboardDetail === "period" ? " dashboard-card-open" : ""}`}
                onClick={() => toggleDashboardDetail("period")}
              >
                <span>Period vouchers</span>
                <strong>{calc.period.length}</strong>
                <small>View Day Book - {periodLabel}</small>
              </button>
              <DashboardInline kind="period" />
            </div>
          )}
          {book !== "india" && <div className="dashboard-card-slot equity-slot">
            <button
              className="dashboard-balance-card"
              onClick={() => { setReport("equity"); setTab("reports"); }}
            >
              {uiTheme === "refresh" && <StatIcon kind="stock" color="#dc2626" />}
              <div className="dashboard-card-main">
                <span>Equity (NVDA)</span>
                <strong>{fmt(equityMktValue)}</strong>
                <small className="equity-price-note">{nvdaPrice ? `@ $${nvdaPrice.toFixed(2)} live` : data?.equity ? "price loading…" : "No equity data"}</small>
              </div>
              <div className="dashboard-card-highlights">
                <span>
                  <b>RSU</b>
                  <em>{fmt(equityRsuVestedValue)}</em>
                </span>
                <span>
                  <b>ESPP</b>
                  <em>{fmt(equityEsppMktValue)}</em>
                </span>
                {equityDailyGL !== null && (
                  <span className={equityDailyGL > 0 ? "equity-daily-chip--pos" : equityDailyGL < 0 ? "equity-daily-chip--neg" : "equity-daily-chip--zero"}>
                    <b>Today</b>
                    <em>{equityDailyGL >= 0 ? "+" : ""}{fmt(equityDailyGL)}</em>
                  </span>
                )}
                {equityScheduledShares > 0 && (
                  <span className="equity-sch-chip">
                    <b>Scheduled</b>
                    <em>{fmt(equityScheduledValue)}</em>
                  </span>
                )}
              </div>
            </button>
          </div>}
        </section>
      )}
      {tab === "bank-import" && data && (
        <>
          {book !== "india" && (
            <div className="report-picker">
              <button
                className={importSource === "plaid" ? "selected" : ""}
                onClick={() => setImportSource("plaid")}
              >
                Plaid
              </button>
              <button
                className={importSource === "schwab" ? "selected" : ""}
                onClick={() => setImportSource("schwab")}
              >
                Schwab
              </button>
              <button
                className={importSource === "retirement" ? "selected" : ""}
                onClick={() => setImportSource("retirement")}
              >
                Retirement
              </button>
            </div>
          )}
          {(importSource === "plaid" || book === "india") && (
            <div className="data-panel">
              <PlaidImport
                data={data}
                apiUrl={apiUrl}
                onSave={(next) => save(next, "bank-import")}
              />
            </div>
          )}
          {importSource === "schwab" && book !== "india" && (
            <div className="data-panel">
              <SchwabImport
                data={data}
                onSave={(next) => save(next, "bank-import")}
              />
            </div>
          )}
          {importSource === "retirement" && book !== "india" && (
            <RetirementReport data={data} fmt={fmt} uiTheme={uiTheme} />
          )}
        </>
      )}
      {tab === "anomalies" && data && (() => {
        const nowMonth = new Date().toISOString().slice(0, 7);
        const nowTs = Date.now();
        const anomalies = data.transactions
          .filter(t => !t.deleted && !t.cancelled && t.date.slice(0, 7) !== nowMonth)
          .sort((a, b) => {
            const ta = a.createdAt || a.lastSyncedAt || "";
            const tb = b.createdAt || b.lastSyncedAt || "";
            if (ta && tb) return tb.localeCompare(ta);
            if (ta) return -1; if (tb) return 1;
            return b.id - a.id;
          });
        const recent3 = anomalies.filter(t => {
          const ts = t.createdAt || t.lastSyncedAt;
          return ts && (nowTs - new Date(ts).getTime()) <= 3 * 86400000;
        });
        const byMonth = new Map<string, typeof anomalies>();
        for (const t of anomalies) {
          const m = t.date.slice(0, 7);
          if (!byMonth.has(m)) byMonth.set(m, []);
          byMonth.get(m)!.push(t);
        }
        const sortedMonths = [...byMonth.keys()].sort().reverse();
        return (
          <div className="data-panel anomaly-panel">
            <h3 style={{ margin: "0 0 4px" }}>Date Anomalies</h3>
            <p style={{ fontSize: "0.8rem", color: "#64748b", margin: "0 0 14px" }}>
              Transactions with a vault posting date outside the current month ({nowMonth}).
              Entries created in the last 3 days are highlighted in orange.
              All accounts are shown.
            </p>
            {recent3.length > 0 && (
              <div className="anomaly-recent-banner">
                <strong>{recent3.length}</strong> entr{recent3.length === 1 ? "y" : "ies"} with a past/future posting date were created in the last 3 days — review for potential duplicates.
              </div>
            )}
            {sortedMonths.map(month => {
              const txs = byMonth.get(month)!;
              const hasRecent = txs.some(t => { const ts = t.createdAt || t.lastSyncedAt; return ts && (nowTs - new Date(ts).getTime()) <= 3 * 86400000; });
              return (
                <details key={month} className="anomaly-month-group" open={hasRecent}>
                  <summary className="anomaly-month-head">
                    <span>{month}</span>
                    <span className="anomaly-month-count">{txs.length} voucher{txs.length !== 1 ? "s" : ""}</span>
                    {hasRecent && <span className="anomaly-recent-badge">Recent entry</span>}
                  </summary>
                  <table className="anomaly-table">
                    <thead>
                      <tr>
                        <th>Posting Date</th>
                        <th>Created (System)</th>
                        <th>Type</th>
                        <th>#</th>
                        <th>Narration</th>
                        <th>Debit</th>
                        <th>Credit</th>
                        <th className="right">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {txs.map(t => {
                        const dr = t.entries.find(e => e.amount < 0);
                        const cr = t.entries.find(e => e.amount > 0);
                        const amt = dr ? Math.abs(dr.amount) : 0;
                        const createdTs = t.createdAt || t.lastSyncedAt;
                        const isNew = createdTs && (nowTs - new Date(createdTs).getTime()) <= 3 * 86400000;
                        const createdLabel = createdTs
                          ? new Date(createdTs).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" })
                          : "—";
                        return (
                          <tr key={t.guid} className={isNew ? "anomaly-row-new" : "anomaly-row"}>
                            <td className="anomaly-date">{fmtDate(t.date)}</td>
                            <td className="anomaly-created">{createdLabel}</td>
                            <td><span className="pill">{t.type}</span></td>
                            <td className="anomaly-num">{t.number || "—"}</td>
                            <td className="anomaly-narr">{t.narration || "—"}</td>
                            <td className="anomaly-acct">{dr?.accountName || "—"}</td>
                            <td className="anomaly-acct">{cr?.accountName || "—"}</td>
                            <td className="right anomaly-amt">{fmt(amt)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </details>
              );
            })}
            {anomalies.length === 0 && (
              <div style={{ color: "#16a34a", fontWeight: 600, padding: 24, textAlign: "center" }}>
                No past/future-dated entries found. All vouchers are in {nowMonth}.
              </div>
            )}
          </div>
        );
      })()}
      {tab === "daybook" && (
        <div className="data-panel">
          <input
            className="search-box"
            placeholder="Search all voucher content"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {dayBookCapped && (
            <div style={{ padding: "6px 12px", background: "#fef9c3", border: "1px solid #fde047", borderRadius: "8px", fontSize: "0.8rem", color: "#713f12", marginBottom: "8px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span>
                {showAllVouchers
                  ? `Showing all ${filteredAll.length} vouchers — large lists can render slowly.`
                  : `Showing ${DAY_BOOK_CAP} of ${filteredAll.length} vouchers — use the search box, or show all.`}
              </span>
              <button onClick={() => setShowAllVouchers((v) => !v)} style={{ padding: "3px 10px", fontSize: "0.75rem", margin: 0 }}>
                {showAllVouchers ? "Show recent only" : `Show all ${filteredAll.length}`}
              </button>
            </div>
          )}
          <TransactionTable
            transactions={filtered}
            formatAmount={fmt}
            onView={(t) => setSelectedVoucher(t as Tx)}
            onEdit={(t) => editVoucher(t as Tx)}
            onCopy={(t) => copyVoucher(t as Tx)}
            onDelete={(t) => deleteVoucher(t as Tx)}
            onClearSearch={() => setQuery("")}
          />
        </div>
      )}
      {tab === "ledgers" && (
        <div className="data-panel">
          {tableFiltersJsx}
          {(() => {
            const ledgerRows = filteredActive
                .map((a) => {
                  const reset = (isProfitLoss(a) || isIncome(a) || isExpense(a)) && year !== "all";
                  const opening = reset ? 0 : a.opening,
                    closing = opening - a.debit + a.credit;
                  return { ...a, opening, closing };
                })
                .filter(
                  (a) =>
                    Math.abs(a.opening) > tol ||
                    a.debit > tol ||
                    a.credit > tol ||
                    Math.abs(a.closing) > tol
                ),
              ledgerTotals = ledgerRows.reduce(
                (s, a) => ({
                  opening: s.opening + displayLedgerBalance(a, a.opening),
                  debit: s.debit + a.debit,
                  credit: s.credit + a.credit,
                  closing: s.closing + displayLedgerBalance(a, a.closing),
                }),
                { opening: 0, debit: 0, credit: 0, closing: 0 }
              );
            return (
              <table>
                <thead>
                  <tr>
                    <SortHead field="name">Ledger</SortHead>
                    <SortHead field="group">Group</SortHead>
                    <SortHead field="opening" right>
                      Opening
                    </SortHead>
                    <SortHead field="debit" right>
                      Period Dr
                    </SortHead>
                    <SortHead field="credit" right>
                      Period Cr
                    </SortHead>
                    <SortHead field="closing" right>
                      Closing
                    </SortHead>
                  </tr>
                </thead>
                <tbody>
                  {ledgerRows.map((a) => (
                    <tr key={a.id}>
                      <td>
                        <LedgerLink a={a} />
                      </td>
                      <td>{a.parent || a.category}</td>
                      <td className="right">
                        {Math.abs(a.opening) > tol ? fmt(displayLedgerBalance(a, a.opening)) : "-"}
                      </td>
                      <td className="right">{a.debit ? fmt(a.debit) : "-"}</td>
                      <td className="right">{a.credit ? fmt(a.credit) : "-"}</td>
                      <td className="right">
                        {Math.abs(a.closing) > tol ? fmt(displayLedgerBalance(a, a.closing)) : "-"}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th>Total</th>
                    <th></th>
                    <th className="right">
                      {Math.abs(ledgerTotals.opening) > tol ? fmt(ledgerTotals.opening) : "-"}
                    </th>
                    <th className="right">{ledgerTotals.debit ? fmt(ledgerTotals.debit) : "-"}</th>
                    <th className="right">
                      {ledgerTotals.credit ? fmt(ledgerTotals.credit) : "-"}
                    </th>
                    <th className="right">
                      {Math.abs(ledgerTotals.closing) > tol ? fmt(ledgerTotals.closing) : "-"}
                    </th>
                  </tr>
                </tfoot>
              </table>
            );
          })()}
        </div>
      )}
      {tab === "masters" && (
        <div className="data-panel">
          <MastersPanel
            data={data}
            onSave={(next, message) => {
              setStatus(message);
              void save(next as Ledger, "masters");
            }}
          />
        </div>
      )}
      {tab === "reports" && (
        <>
          <div className="report-picker">
            <button
              className={report === "trial" ? "selected" : ""}
              onClick={() => setReport("trial")}
            >
              Trial Balance
            </button>
            <button
              className={report === "income" ? "selected" : ""}
              onClick={() => setReport("income")}
            >
              Income &amp; Expenditure
            </button>
            <button
              className={report === "balance" ? "selected" : ""}
              onClick={() => setReport("balance")}
            >
              Balance Sheet
            </button>
            <button
              className={report === "cashflow" ? "selected" : ""}
              onClick={() => setReport("cashflow")}
            >
              Cash Flow
            </button>
            <button
              className={report === "cash" ? "selected" : ""}
              onClick={() => setReport("cash")}
            >
              Cash and Bank
            </button>
            <button
              className={report === "networth" ? "selected" : ""}
              onClick={() => setReport("networth")}
            >
              Net Worth
            </button>
            {book !== "india" && (
              <button
                className={report === "equity" ? "selected" : ""}
                onClick={() => setReport("equity")}
              >
                Equity
              </button>
            )}
            {book !== "india" && (
              <button
                className={report === "trading" ? "selected" : ""}
                onClick={() => setReport("trading")}
              >
                Trading
              </button>
            )}
            <button
              className={report === "tax" ? "selected" : ""}
              onClick={() => setReport("tax")}
            >
              Tax
            </button>
            <button
              className={report === "recon" ? "selected" : ""}
              onClick={() => setReport("recon")}
            >
              Recon
            </button>
            <button
              className={report === "trash" ? "selected" : ""}
              onClick={() => setReport("trash")}
            >
              Trash
            </button>
          </div>
          {report === "trash" && data && (() => {
            const ledger = data as Ledger;
            const deleted = ledger.transactions
              .filter(t => t.deleted)
              .sort((a, b) => b.id - a.id);

            async function restoreTx(guid: string) {
              const next: Ledger = {
                ...ledger,
                transactions: ledger.transactions.map(t =>
                  t.guid === guid ? { ...t, deleted: false } : t
                ),
              };
              const ok = await save(next, "trash");
              if (!ok) setStatus("Restore failed.");
            }

            async function restoreAll() {
              if (!window.confirm(`Restore all ${deleted.length} deleted voucher(s)?`)) return;
              const next: Ledger = {
                ...ledger,
                transactions: ledger.transactions.map(t => t.deleted ? { ...t, deleted: false } : t),
              };
              const ok = await save(next, "trash");
              if (ok) setStatus(`${deleted.length} voucher(s) restored.`);
              else setStatus("Restore failed.");
            }

            // Same-date, same-accounts, same-amount duplicate detection -- moved here from
            // Import > Plaid (a duplicate can come from any source, not just a Plaid re-import,
            // so it belongs alongside Trash's other "vouchers that shouldn't be counted" view
            // rather than tucked inside one specific import tool).
            const active = ledger.transactions.filter(v => !v.deleted && !v.cancelled);
            const dupeMap = new Map<string, typeof active>();
            for (const v of active) {
              const dr = v.entries?.find(e => e.amount < 0);
              const cr = v.entries?.find(e => e.amount > 0);
              if (!dr || !cr) continue;
              const key = `${v.date}|${dr.accountId}|${cr.accountId}|${Math.abs(dr.amount).toFixed(2)}`;
              if (!dupeMap.has(key)) dupeMap.set(key, []);
              dupeMap.get(key)!.push(v);
            }
            const dupeGroups = [...dupeMap.entries()]
              .filter(([, vs]) => vs.length > 1)
              .map(([key, vs]) => {
                const [date, drId, crId, amt] = key.split("|");
                return {
                  date,
                  amount: parseFloat(amt),
                  drAcct: ledger.accounts.find(a => a.id === +drId),
                  crAcct: ledger.accounts.find(a => a.id === +crId),
                  txs: vs.sort((a, b) => a.id - b.id),
                };
              })
              .sort((a, b) => b.date.localeCompare(a.date));

            // A voucher already pushed to Tally (has a tallyGuid/syncFingerprint) needs
            // syncStatus flagged "pending" on delete so the sync engine actually removes it from
            // Tally too -- otherwise it vanishes from the app while quietly staying in Tally
            // forever. One never synced can just be dropped locally.
            function markDupeDeleted(v: Tx): Tx {
              if (!v.tallyGuid && !v.syncFingerprint) return { ...v, deleted: true };
              return { ...v, deleted: true, syncStatus: "pending", lastSyncedAt: undefined };
            }
            async function deleteDupeTx(id: number) {
              const next: Ledger = { ...ledger, transactions: ledger.transactions.map(v => v.id === id ? markDupeDeleted(v) : v) };
              const ok = await save(next, "trash");
              if (ok) setStatus(`Voucher #${id} deleted.`);
              else setStatus("Delete failed.");
            }
            async function deleteAllDupeExtras() {
              const extraIds = new Set(dupeGroups.flatMap(g => g.txs.slice(1).map(v => v.id)));
              if (!extraIds.size) return;
              if (!window.confirm(`Delete ${extraIds.size} extra duplicate voucher(s)? The oldest entry in each group will be kept.`)) return;
              const next: Ledger = { ...ledger, transactions: ledger.transactions.map(v => extraIds.has(v.id) ? markDupeDeleted(v) : v) };
              const ok = await save(next, "trash");
              if (ok) setStatus(`${extraIds.size} duplicate(s) deleted.`);
              else setStatus("Delete failed.");
            }

            return (
              <div className="data-panel trash-panel">
                <div className="report-picker" style={{ marginBottom: 12 }}>
                  <button
                    className={trashSubTab === "deleted" ? "selected" : ""}
                    onClick={() => setTrashSubTab("deleted")}
                  >
                    Deleted{deleted.length > 0 ? ` (${deleted.length})` : ""}
                  </button>
                  <button
                    className={trashSubTab === "duplicate" ? "selected" : ""}
                    onClick={() => setTrashSubTab("duplicate")}
                  >
                    Duplicate{dupeGroups.length > 0 ? ` (${dupeGroups.length})` : ""}
                  </button>
                </div>

                {trashSubTab === "deleted" && (
                  <>
                    <div className="trash-header">
                      <div>
                        <h3 style={{ margin: 0 }}>Trash — Deleted Vouchers</h3>
                        <p style={{ fontSize: "0.8rem", color: "#64748b", margin: "4px 0 0" }}>
                          All soft-deleted vouchers. Click Restore to bring one back, or Restore All to undo all deletions.
                          Sorted most-recently-deleted first (highest voucher ID).
                        </p>
                      </div>
                      {deleted.length > 0 && (
                        <button className="trash-restore-all-btn" onClick={restoreAll}>
                          Restore All ({deleted.length})
                        </button>
                      )}
                    </div>
                    {deleted.length === 0 ? (
                      <div className="trash-empty">Trash is empty — no deleted vouchers.</div>
                    ) : (
                      <table className="trash-table">
                        <thead>
                          <tr>
                            <th>Date</th>
                            <th>Type</th>
                            <th>#</th>
                            <th>Narration</th>
                            <th>Debit</th>
                            <th>Credit</th>
                            <th className="right">Amount</th>
                            <th>Sync</th>
                            <th></th>
                          </tr>
                        </thead>
                        <tbody>
                          {deleted.map(t => {
                            const dr = t.entries.find(e => e.amount < 0);
                            const cr = t.entries.find(e => e.amount > 0);
                            const amt = dr ? Math.abs(dr.amount) : 0;
                            return (
                              <tr key={t.guid} className="trash-row">
                                <td className="trash-date">{fmtDate(t.date)}</td>
                                <td><span className="pill">{t.type}</span></td>
                                <td className="trash-num">{t.number || "—"}</td>
                                <td className="trash-narr">{t.narration || "—"}</td>
                                <td className="trash-acct">{dr?.accountName || t.entries.map(e => e.accountName).join(", ") || "—"}</td>
                                <td className="trash-acct">{cr?.accountName || "—"}</td>
                                <td className="right trash-amt">{fmt(amt)}</td>
                                <td className="trash-sync">{t.syncStatus || "—"}</td>
                                <td>
                                  <button className="trash-restore-btn" onClick={() => restoreTx(t.guid)}>
                                    Restore
                                  </button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    )}
                  </>
                )}

                {trashSubTab === "duplicate" && (
                  <div className="plaid-dupe-section">
                    {dupeGroups.length === 0 ? (
                      <div className="plaid-dupe-empty">No duplicate transactions found in your vault.</div>
                    ) : (
                      <>
                        <div className="plaid-dupe-summary">
                          Found <strong>{dupeGroups.length}</strong> duplicate group{dupeGroups.length !== 1 ? "s" : ""} — same date, same accounts, same amount.{" "}
                          <button className="plaid-dupe-del-all-btn" onClick={deleteAllDupeExtras}>
                            Delete All Extras ({dupeGroups.reduce((s, g) => s + g.txs.length - 1, 0)})
                          </button>
                        </div>
                        {dupeGroups.map((g, gi) => (
                          <div key={gi} className="plaid-dupe-group">
                            <div className="plaid-dupe-header">
                              <span className="plaid-dupe-date">{fmtDate(g.date)}</span>
                              <span className="plaid-dupe-amt">${g.amount.toFixed(2)}</span>
                              <span className="plaid-dupe-accounts">
                                Dr: <strong>{g.drAcct?.name ?? "—"}</strong>
                                {" / "}
                                Cr: <strong>{g.crAcct?.name ?? "—"}</strong>
                              </span>
                            </div>
                            {g.txs.map((v, vi) => (
                              <div key={v.id} className={`plaid-dupe-row${vi === 0 ? " plaid-dupe-first" : " plaid-dupe-extra"}`}>
                                <span className="plaid-dupe-id">#{v.id}</span>
                                <span className="plaid-dupe-type">{v.type}</span>
                                <span className="plaid-dupe-narr">{v.narration || "—"}</span>
                                <span className="plaid-dupe-sync">{v.syncStatus || ""}</span>
                                <button
                                  className="plaid-dupe-del-btn"
                                  onClick={() => {
                                    if (window.confirm(`Delete voucher #${v.id} "${v.narration || ""}"?`)) deleteDupeTx(v.id);
                                  }}
                                >
                                  Delete
                                </button>
                              </div>
                            ))}
                          </div>
                        ))}
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })()}
          {report === "trial" && (
            <div className="data-panel">
              <h3>
                Trial Balance — <PeriodSelect />
              </h3>
              {tableFiltersJsx}
              {(() => {
                const tR = adjustedFilteredRows.map((a) => ({
                  ...a,
                  tO: a.opening,
                  tC: a.closing,
                }));
                const tODr = tR.reduce((s, a) => s + (a.tO < 0 ? -a.tO : 0), 0),
                  tOCr = tR.reduce((s, a) => s + (a.tO > 0 ? a.tO : 0), 0),
                  tCDr = tR.reduce((s, a) => s + (a.tC < 0 ? -a.tC : 0), 0),
                  tCCr = tR.reduce((s, a) => s + (a.tC > 0 ? a.tC : 0), 0);
                return (
                  <table>
                    <thead>
                      <tr>
                        <SortHead field="name">Ledger</SortHead>
                        <SortHead field="opening" right>
                          Opening Dr
                        </SortHead>
                        <SortHead field="opening" right>
                          Opening Cr
                        </SortHead>
                        <SortHead field="debit" right>
                          Period Dr
                        </SortHead>
                        <SortHead field="credit" right>
                          Period Cr
                        </SortHead>
                        <SortHead field="closing" right>
                          Closing Dr
                        </SortHead>
                        <SortHead field="closing" right>
                          Closing Cr
                        </SortHead>
                      </tr>
                    </thead>
                    <tbody>
                      {tR.map((a) => (
                        <tr key={a.id}>
                          <td>
                            <LedgerLink a={a} />
                          </td>
                          <td className="right">{a.tO < 0 ? fmt(-a.tO) : "-"}</td>
                          <td className="right">{a.tO > 0 ? fmt(a.tO) : "-"}</td>
                          <td className="right">{a.debit ? fmt(a.debit) : "-"}</td>
                          <td className="right">{a.credit ? fmt(a.credit) : "-"}</td>
                          <td className="right">{a.tC < 0 ? fmt(-a.tC) : "-"}</td>
                          <td className="right">{a.tC > 0 ? fmt(a.tC) : "-"}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <th>Totals</th>
                        <th className="right">{fmt(tODr)}</th>
                        <th className="right">{fmt(tOCr)}</th>
                        <th className="right">{fmt(tR.reduce((s, a) => s + a.debit, 0))}</th>
                        <th className="right">{fmt(tR.reduce((s, a) => s + a.credit, 0))}</th>
                        <th className="right">{fmt(tCDr)}</th>
                        <th className="right">{fmt(tCCr)}</th>
                      </tr>
                    </tfoot>
                  </table>
                );
              })()}
            </div>
          )}
          {report === "income" && (
            <>
              <h3 className="report-inline-heading">
                Income &amp; Expenditure — <PeriodSelect />
              </h3>
              <div className="equity-summary-row" style={{ marginBottom: "0.75rem" }}>
                <div className="equity-summary-col" style={{ flex: "1 1 160px" }}>
                  <div className="equity-summary-card">
                    {uiTheme === "refresh" && <StatIcon kind="trending-up" color="#16a34a" />}
                    <div className="equity-summary-card-body">
                      <span>Period Income</span>
                      <strong className="equity-amt">{fmt(periodIncome)}</strong>
                    </div>
                  </div>
                </div>
                <div className="equity-summary-col" style={{ flex: "1 1 160px" }}>
                  <div className="equity-summary-card">
                    {uiTheme === "refresh" && <StatIcon kind="receipt" color="#dc2626" />}
                    <div className="equity-summary-card-body">
                      <span>Period Expenditure</span>
                      <strong className="equity-amt">{fmt(periodExpense)}</strong>
                    </div>
                  </div>
                </div>
                <div className="equity-summary-col" style={{ flex: "1 1 160px" }}>
                  <div className="equity-summary-card">
                    {uiTheme === "refresh" && <StatIcon kind="scale" color={periodSurplus >= 0 ? "#16a34a" : "#dc2626"} />}
                    <div className="equity-summary-card-body">
                      <span>Surplus / (Deficit)</span>
                      <strong className="equity-amt">{fmt(periodSurplus)}</strong>
                      <em>transferred to Capital</em>
                    </div>
                  </div>
                </div>
                {periodExpense > tol && (() => {
                  const byCategory = new Map<string, number>();
                  for (const r of periodExpenseRows) {
                    const cat = r.parent || r.category || "Other";
                    byCategory.set(cat, (byCategory.get(cat) || 0) + r.closing);
                  }
                  const segments = [...byCategory.entries()]
                    .sort((a, b) => b[1] - a[1])
                    .map(([label, value], i) => ({ label, value, color: DONUT_PALETTE[i % DONUT_PALETTE.length] }));
                  return (
                    <div className="equity-summary-col" style={{ flex: "1.4 1 220px" }}>
                      <div className="equity-summary-card" style={{ alignItems: "center" }}>
                        <div className="equity-summary-card-body" style={{ width: "100%" }}>
                          <span>Expense Breakdown</span>
                          <DonutChart segments={segments} size={110} thickness={16} legend={false} centerLabel="Total" centerValue={fmt(periodExpense)} fmt={fmt} />
                        </div>
                      </div>
                    </div>
                  );
                })()}
              </div>
              <GroupedReport
                title1="Expenditure"
                rows1={periodExpenseRows}
                title2="Income"
                rows2={periodIncomeRows}
                link={(a) => <LedgerLink a={a} />}
                fmt={fmt}
              />
            </>
          )}{" "}
          {report === "balance" && (
            <>
              <h3 className="report-inline-heading">
                Balance Sheet — <PeriodSelect />
              </h3>
              <BalanceSheetReport
                assets={assetRows}
                liabilities={liabilityRows}
                capitalTransfer={capitalTransfer}
                plRows={rows.filter(isProfitLoss)}
                tol={tol}
                link={(a) => <LedgerLink a={a} />}
                fmt={fmt}
                onNavigateToIE={() => setReport("income")}
              />
            </>
          )}{" "}
          {report === "cashflow" && (
            <>
              <h3 className="report-inline-heading">
                Cash Flow — <PeriodSelect />
              </h3>
              <CashFlowReport
                periodLabel={periodLabel}
                cashOpening={cashOpening}
                cashInflows={cashInflows}
                cashOutflows={cashOutflows}
                cashNet={cashNet}
                cashFlowClosing={cashFlowClosing}
                cashBank={cashBank}
                cashFlowGroups={cashFlowGroups}
                tol={tol}
                fmt={fmt}
                onGroup={(group) => setCashFlowDetail({ group })}
                onLedger={(group, ledger) => setCashFlowDetail({ group, ledger })}
                uiTheme={uiTheme}
              />
            </>
          )}{" "}
          {report === "cash" && (() => {
            const cashBankRows = active.filter((a) => isCashBank(a) && Math.abs(a.closing) > tol);
            const bankTotal = cashBankRows
              .filter((a) => /bank accounts/i.test(a.parent || ""))
              .reduce((s, a) => s - a.closing, 0);
            const cashTotal = cashBankRows
              .filter((a) => /cash-in-hand/i.test(a.parent || ""))
              .reduce((s, a) => s - a.closing, 0);
            return (
              <div className="data-panel">
                <h3>
                  Cash and Bank Closing Balances — <PeriodSelect />
                </h3>
                <div className="equity-summary-row" style={{ margin: "0.75rem 0" }}>
                  <div className="equity-summary-col">
                    <div className="equity-summary-card">
                      {uiTheme === "refresh" && <StatIcon kind="bank" color="#1e40af" />}
                      <div className="equity-summary-card-body">
                        <span>Bank Accounts</span>
                        <strong className="equity-amt">{fmt(bankTotal)}</strong>
                      </div>
                    </div>
                  </div>
                  <div className="equity-summary-col">
                    <div className="equity-summary-card">
                      {uiTheme === "refresh" && <StatIcon kind="cash" color="#16a34a" />}
                      <div className="equity-summary-card-body">
                        <span>Cash in Hand</span>
                        <strong className="equity-amt">{fmt(cashTotal)}</strong>
                      </div>
                    </div>
                  </div>
                  <div className="equity-summary-col">
                    <div className="equity-summary-card">
                      {uiTheme === "refresh" && <StatIcon kind="wallet" color="#7c3aed" />}
                      <div className="equity-summary-card-body">
                        <span>Total Cash and Bank</span>
                        <strong className="equity-amt">{fmt(cashBank)}</strong>
                      </div>
                    </div>
                  </div>
                </div>
                {cashBankRows.map((a) => (
                  <div className="report-line" key={a.id}>
                    <LedgerLink a={a} />
                    <strong>{fmt(-a.closing)}</strong>
                  </div>
                ))}
                <div className="report-total">
                  <span>Total cash and bank</span>
                  <strong>{fmt(cashBank)}</strong>
                </div>
              </div>
            );
          })()}
          {report === "equity" && data && (
            <EquityReport
              grants={data.equity?.grants ?? []}
              esppPurchases={data.equity?.esppPurchases ?? []}
              onSave={async (grants, esppPurchases) => {
                await save({ ...data, equity: { grants, esppPurchases } }, "reports");
              }}
              fmt={fmt}
              uiTheme={uiTheme}
            />
          )}
          {report === "trading" && data && (
            <TradingReport
              fmt={fmt}
              uiTheme={uiTheme}
              trades={data.trades}
              onSave={async (trades) => {
                await save({ ...data, trades }, "reports");
              }}
              data={data}
              onSaveLedger={(next) => save(next, "reports")}
            />
          )}
          {report === "tax" && data && book === "india" && (
            <IndiaTaxReport
              indiaTax={data.indiaTax}
              onSave={async (indiaTax) => {
                await save({ ...data, indiaTax }, "reports");
              }}
              fmt={fmt}
              uiTheme={uiTheme}
              transactions={data.transactions}
              accounts={data.accounts}
            />
          )}
          {report === "tax" && data && book !== "india" && (
            <TaxReport
              payroll={data.payroll}
              transactions={data.transactions}
              equity={data.equity}
              accounts={data.accounts}
              onSave={async (payroll) => {
                return await save({ ...data, payroll }, "reports");
              }}
              onViewVoucher={editVoucher}
              fmt={fmt}
              uiTheme={uiTheme}
              livePrice={nvdaPrice}
            />
          )}
          {report === "recon" && data && (
            <ReconReport data={data} fmt={fmt} uiTheme={uiTheme} />
          )}
          {report === "networth" && (
            <>
              <h3 className="report-inline-heading">
                Net Worth — <PeriodSelect />
              </h3>
              <NetWorthReport
                assets={netWorthAssetRows}
                liabilities={realLiabilityRows}
                trend={netWorthTrendWithEquity}
                fmt={fmt}
                uiTheme={uiTheme}
                onSelectAccount={(id) => setSelected(id)}
                onNavigateSource={(dest) => {
                  if (dest === "retirement") {
                    setTab("bank-import");
                    setImportSource("retirement");
                  } else {
                    setTab("reports");
                    setReport("equity");
                  }
                }}
              />
            </>
          )}
        </>
      )}
      {tab === "new" && (
        <div className="data-panel form-panel">
          <div className="form-heading">
            <h3>
              {editTx
                ? "Edit posted voucher"
                : copyTx
                  ? "Copy and edit voucher"
                  : "Record balanced voucher"}
            </h3>
            <button
              onClick={() => {
                setCopyTx(null);
                setEditTx(null);
                if (!copyTx && !editTx) setTab("dashboard");
              }}
            >
              Cancel
            </button>
          </div>
          {editTx && (
            <p className="edit-note">
              You are changing posted voucher {editTx.type} {editTx.number}. Saving will replace
              this voucher and recalculate all affected reports.
            </p>
          )}
          {copyTx && (
            <p className="copy-note">
              This is a new voucher based on {copyTx.type} {copyTx.number}. Change any field below;
              the original will not be changed.
            </p>
          )}
          <form
            ref={entryFormRef}
            key={editTx?.guid || copyTx?.guid || newVoucherType || "new"}
            className="entry-form voucher-lines-form"
            onSubmit={add}
          >
            <label>
              Voucher type
              <select name="type" defaultValue={(editTx || copyTx)?.type || newVoucherType || "Payment"}>
                {(data.voucherTypes || ["Payment", "Receipt", "Contra", "Journal"]).map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </label>
            <label>
              Date
              <input
                name="date"
                type="date"
                defaultValue={(editTx || copyTx)?.date || new Date().toISOString().slice(0, 10)}
                required
              />
            </label>
            <label>
              Voucher number
              <input
                name="reference"
                value={editTx?.number || "Assigned automatically when saved"}
                readOnly
                aria-readonly="true"
              />
            </label>
            <section className="voucher-line-editor wide">
              <div className="voucher-line-toolbar">
                <strong>Ledger lines</strong>
                <span>
                  Debit {fmt(voucherDebitDraftTotal)} | Credit {fmt(voucherCreditDraftTotal)}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    setVoucherLines((lines) => [
                      ...lines,
                      { id: crypto.randomUUID(), side: "debit", accountId: "", amount: "" },
                    ])
                  }
                >
                  + Debit line
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setVoucherLines((lines) => [
                      ...lines,
                      { id: crypto.randomUUID(), side: "credit", accountId: "", amount: "" },
                    ])
                  }
                >
                  + Credit line
                </button>
              </div>
              <div className="voucher-line-head">
                <span>Side</span>
                <span>Ledger</span>
                <span>Amount</span>
                <span />
              </div>
              {voucherLines.map((line, index) => (
                <div
                  className={
                    "voucher-line-row" +
                    (index === voucherLines.length - 1 && voucherLines.length > 2
                      ? " voucher-line-auto"
                      : "")
                  }
                  key={line.id}
                >
                  <select
                    value={line.side}
                    onChange={(e) => {
                      const val = e.target.value as "debit" | "credit";
                      setVoucherLines((lines) => {
                        const updated = lines.map((row, i) => i === index ? { ...row, side: val } : row);
                        return autoBalance(updated, index);
                      });
                    }}
                  >
                    <option value="debit">Dr</option>
                    <option value="credit">Cr</option>
                  </select>
                  <select
                    value={line.accountId}
                    onChange={(e) =>
                      setVoucherLines((lines) =>
                        lines.map((row, i) =>
                          i === index ? { ...row, accountId: e.target.value } : row
                        )
                      )
                    }
                    required
                  >
                    <option value="">Select ledger</option>
                    {data.accounts
                      .filter((a) => a.active !== false)
                      .sort((a, b) => a.name.localeCompare(b.name))
                      .map((a) => (
                        <option value={a.id} key={a.id}>
                          {a.name}
                        </option>
                      ))}
                  </select>
                  <input
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={line.amount}
                    onChange={(e) => {
                      const val = e.target.value;
                      setVoucherLines((lines) => {
                        const updated = lines.map((row, i) => i === index ? { ...row, amount: val } : row);
                        return autoBalance(updated, index);
                      });
                    }}
                    required
                  />
                  <button
                    type="button"
                    disabled={voucherLines.length <= 2}
                    onClick={() => setVoucherLines((lines) => lines.filter((_, i) => i !== index))}
                  >
                    Remove
                  </button>
                </div>
              ))}
              <div
                className={
                  Math.abs(voucherDebitDraftTotal - voucherCreditDraftTotal) < 0.005
                    ? "voucher-balance-ok"
                    : "voucher-balance-diff"
                }
              >
                <strong>Difference</strong>
                <span>{fmt(voucherDebitDraftTotal - voucherCreditDraftTotal)}</span>
              </div>
              <div className="voucher-ledger-create">
                <button type="button" onClick={() => setInlineLedgerSide("debit")}>
                  + New debit ledger
                </button>
                <button type="button" onClick={() => setInlineLedgerSide("credit")}>
                  + New credit ledger
                </button>
              </div>
            </section>
            <label className="wide">
              Narration
              <textarea
                name="narration"
                rows={3}
                defaultValue={cleanText((editTx || copyTx)?.narration || "")}
              />
            </label>
            <button className="primary wide">
              {editTx
                ? "Encrypt and update voucher"
                : copyTx
                  ? "Encrypt and save as new voucher"
                  : "Encrypt and save voucher"}
            </button>
          </form>
          {inlineLedgerSide && (
            <FloatingWindow title="Create Ledger from Voucher" onClose={() => setInlineLedgerSide(null)}>
              <form className="master-form" onSubmit={createLedgerInsideVoucher}>
                <p>
                  The ledger will be selected as the {inlineLedgerSide} account and synchronized to
                  Tally before this voucher.
                </p>
                <label>
                  Ledger name
                  <input name="name" required autoFocus />
                </label>
                <label>
                  Account group
                  <select name="parent" required>
                    {[
                      ...new Set([
                        ...data.accounts.map((a) => a.parent).filter(Boolean),
                        ...(data.groups || []).filter((g) => g.active !== false).map((g) => g.name),
                      ]),
                    ]
                      .sort()
                      .map((group) => (
                        <option key={group}>{group}</option>
                      ))}
                  </select>
                </label>
                <label>
                  Currency
                  <select name="currency" defaultValue={data.currency}>
                    {[...new Set([data.currency, ...(data.currencies || [])])].map((currency) => (
                      <option key={currency}>{currency}</option>
                    ))}
                  </select>
                </label>
                <div className="opening-fields">
                  <label>
                    Opening balance
                    <input name="opening" type="number" min="0" step="0.01" defaultValue="0" />
                  </label>
                  <label>
                    Balance side
                    <select name="side" defaultValue="Dr">
                      <option>Dr</option>
                      <option>Cr</option>
                    </select>
                  </label>
                </div>
                <label className="check-label">
                  <input type="checkbox" checked readOnly /> Active ledger
                </label>
                <div>
                  <button type="button" onClick={() => setInlineLedgerSide(null)}>
                    Cancel
                  </button>
                  <button className="primary">Create and select</button>
                </div>
              </form>
            </FloatingWindow>
          )}
        </div>
      )}
      {cashFlowDetail && (
        <FloatingWindow title={cashFlowDetail?.ledger ?? cashFlowDetail?.group ?? ""} onClose={() => setCashFlowDetail(null)} wide initialWidth={1100} initialHeight={700}>
          <div className="ledger-drill-panel">
            <p>
              Cash Flow | <PeriodSelect />
            </p>
            <TransactionTable
              transactions={cashFlowItems
                .filter((x) =>
                  cashFlowDetail?.ledger
                    ? x.group === cashFlowDetail.group && x.ledger === cashFlowDetail.ledger
                    : x.group === cashFlowDetail?.group
                )
                .slice()
                .reverse()
                .map((x) => x.t)}
              formatAmount={fmt}
              onView={(t) => setSelectedVoucher(t as Tx)}
              onEdit={(t) => editVoucher(t as Tx)}
              onCopy={(t) => copyVoucher(t as Tx)}
              onDelete={(t) => deleteVoucher(t as Tx)}
            />
          </div>
        </FloatingWindow>
      )}
      {selectedRow && (
        <FloatingWindow title={selectedRow.name} onClose={() => setSelected(null)} wide initialWidth={1100} initialHeight={700}>
          <div className="ledger-drill-panel">
            <p>
              {selectedRow.parent || selectedRow.category} | <PeriodSelect />
            </p>
            <section className="drill-summary">
              <span>
                Opening
                <strong>{fmt(displayLedgerBalance(selectedRow, selectedRow.opening))}</strong>
              </span>
              <span>
                Period debit<strong>{fmt(selectedRow.debit)}</strong>
              </span>
              <span>
                Period credit<strong>{fmt(selectedRow.credit)}</strong>
              </span>
              <span>
                Closing
                <strong>{fmt(displayLedgerBalance(selectedRow, selectedRow.closing))}</strong>
              </span>
            </section>
            <TransactionTable
              transactions={selectedTx}
              selectedLedgerName={selectedRow.name}
              openingBalance={-selectedRow.opening}
              formatAmount={fmt}
              onView={(t) => setSelectedVoucher(t as Tx)}
              onEdit={(t) => editVoucher(t as Tx)}
              onCopy={(t) => copyVoucher(t as Tx)}
              onDelete={(t) => deleteVoucher(t as Tx)}
            />
          </div>
        </FloatingWindow>
      )}
      {selectedVoucher && (
        <FloatingWindow
          title={
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {uiTheme === "refresh" && <VoucherTypeBadge type={selectedVoucher.type} />}
              {selectedVoucher.type} Voucher {selectedVoucher.number}
            </span>
          }
          onClose={() => setSelectedVoucher(null)}
          wide
        >
          <div className="voucher-detail">
            <p>
              {selectedVoucher.date.split("-").reverse().join("-")} | {data.company}
            </p>
            <section className="voucher-meta">
              <span>
                Date<strong>{selectedVoucher.date.split("-").reverse().join("-")}</strong>
              </span>
              <span>
                Voucher type<strong>{selectedVoucher.type}</strong>
              </span>
              <span>
                Reference<strong>{selectedVoucher.number || "-"}</strong>
              </span>
              <span>
                Status<strong>{selectedVoucher.cancelled ? "Cancelled" : "Posted"}</strong>
              </span>
            </section>
            <h3>Narration</h3>
            <p className="voucher-narration">{cleanText(selectedVoucher.narration) || "-"}</p>
            {uiTheme === "refresh" ? (
              <VoucherFlow entries={selectedVoucher.entries} fmt={fmt} />
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Ledger</th>
                    <th className="right">Debit</th>
                    <th className="right">Credit</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedVoucher.entries.map((e, i) => (
                    <tr key={`${e.accountId}-${i}`}>
                      <td>{e.accountName}</td>
                      <td className="right">{e.amount < 0 ? fmt(-e.amount) : "-"}</td>
                      <td className="right">{e.amount > 0 ? fmt(e.amount) : "-"}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th>Total</th>
                    <th className="right">
                      {fmt(
                        selectedVoucher.entries
                          .filter((e) => e.amount < 0)
                          .reduce((n, e) => n - e.amount, 0)
                      )}
                    </th>
                    <th className="right">
                      {fmt(
                        selectedVoucher.entries
                          .filter((e) => e.amount > 0)
                          .reduce((n, e) => n + e.amount, 0)
                      )}
                    </th>
                  </tr>
                </tfoot>
              </table>
            )}
            <div className="voucher-detail-actions">
              {!selectedVoucher.cancelled && (
                <button
                  className="edit-voucher"
                  onClick={() => {
                    setSelectedVoucher(null);
                    editVoucher(selectedVoucher);
                  }}
                >
                  Edit
                </button>
              )}
              <button
                className="copy-voucher"
                onClick={() => {
                  setSelectedVoucher(null);
                  copyVoucher(selectedVoucher);
                }}
              >
                Copy
              </button>
              <button
                className="delete-voucher"
                onClick={() => {
                  setSelectedVoucher(null);
                  deleteVoucher(selectedVoucher);
                }}
              >
                Delete
              </button>
            </div>
          </div>
        </FloatingWindow>
      )}
    </div>
  );
}

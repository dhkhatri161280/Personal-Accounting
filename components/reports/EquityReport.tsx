"use client";
import { useState, useEffect, useCallback } from "react";
import type { RsuGrant, RsuVest, EsppPurchase } from "@/lib/vault-types";

function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ISO YYYY-MM-DD → DD-MM-YYYY (matches the rest of the app)
function fmtDate(iso: string) {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : iso;
}

// ── Pre-populated seed from Vesting Schedule.xlsx ────────────────────────
const NVDA_SEED = {
  grants: [
    { id:"44f662e1", ticker:"NVDA", grantDate:"2021-09-01", totalShares:3160, grantPrice:17.789, vests:[
      {id:"64997692",vestDate:"2022-09-22",shares:190,vestPrice:13.26,sharesHeld:110,taxShares:80},{id:"a3a2921a",vestDate:"2022-12-21",shares:200,vestPrice:17.67,sharesHeld:130,taxShares:70},{id:"ec53c255",vestDate:"2023-03-15",shares:200,vestPrice:24.23,sharesHeld:110,taxShares:90},{id:"215d3348",vestDate:"2023-06-21",shares:200,vestPrice:43.04,sharesHeld:110,taxShares:90},{id:"7908f8b8",vestDate:"2023-09-21",shares:190,vestPrice:42.24,sharesHeld:120,taxShares:70},{id:"acf63345",vestDate:"2023-12-21",shares:200,vestPrice:48.09,sharesHeld:120,taxShares:80},{id:"506caad4",vestDate:"2024-03-21",shares:200,vestPrice:90.37,sharesHeld:0,taxShares:90,salePrice:132.25},{id:"fc1e1eb1",vestDate:"2024-06-21",shares:200,vestPrice:135.58,sharesHeld:0,taxShares:74,salePrice:132.25},{id:"a5e3a47c",vestDate:"2024-09-21",shares:190,vestPrice:115.59,sharesHeld:0,taxShares:70,salePrice:132.25},{id:"3ba0da14",vestDate:"2024-12-21",shares:200,vestPrice:135.07,sharesHeld:0,taxShares:74,salePrice:120.00},{id:"2ef03556",vestDate:"2025-03-21",shares:200,vestPrice:115.43,sharesHeld:113,taxShares:87},{id:"1ad69f96",vestDate:"2025-06-21",shares:200,vestPrice:144.12,sharesHeld:126,taxShares:74},{id:"5f13346b",vestDate:"2025-09-21",shares:190,vestPrice:174.88,sharesHeld:120,taxShares:70},{id:"73e7d0e4",vestDate:"2025-12-21",shares:200,vestPrice:184.97,sharesHeld:126,taxShares:74},{id:"1a28c615",vestDate:"2026-03-21",shares:200,vestPrice:181.93,sharesHeld:113,taxShares:87,salePrice:173.69},{id:"3f9d52ae",vestDate:"2026-06-21",shares:200,vestPrice:207.41,sharesHeld:126,taxShares:74},
    ]},
    { id:"006a5b73", ticker:"NVDA", grantDate:"2021-09-01", totalShares:10020, grantPrice:17.964, vests:[
      {id:"16ed83bd",vestDate:"2022-09-22",shares:190,vestPrice:13.26,sharesHeld:110,taxShares:80},{id:"408de10f",vestDate:"2022-12-21",shares:190,vestPrice:17.67,sharesHeld:120,taxShares:70},{id:"0b1f7848",vestDate:"2023-03-15",shares:1740,vestPrice:24.23,sharesHeld:990,taxShares:750},{id:"b1eadb7f",vestDate:"2023-03-21",shares:190,vestPrice:24.23,sharesHeld:100,taxShares:90},{id:"b6d7ae0b",vestDate:"2023-06-21",shares:630,vestPrice:43.04,sharesHeld:370,taxShares:260},{id:"ea7cfab9",vestDate:"2023-09-21",shares:620,vestPrice:42.24,sharesHeld:390,taxShares:230},{id:"f394706a",vestDate:"2023-12-21",shares:630,vestPrice:48.09,sharesHeld:390,taxShares:240},{id:"09d8dc14",vestDate:"2024-03-21",shares:630,vestPrice:90.37,sharesHeld:0,taxShares:280,salePrice:132.25},{id:"f4ef0078",vestDate:"2024-06-21",shares:620,vestPrice:135.58,sharesHeld:0,taxShares:228,salePrice:132.25},{id:"83fc2e6b",vestDate:"2024-09-21",shares:630,vestPrice:115.59,sharesHeld:0,taxShares:232,salePrice:132.25},{id:"6c724a5e",vestDate:"2024-12-21",shares:620,vestPrice:135.07,sharesHeld:271,taxShares:229,salePrice:120.00},{id:"ec66780e",vestDate:"2025-03-21",shares:630,vestPrice:115.43,sharesHeld:358,taxShares:272},{id:"f32bd5a5",vestDate:"2025-06-21",shares:630,vestPrice:144.12,sharesHeld:395,taxShares:235},{id:"5b7c6506",vestDate:"2025-09-21",shares:620,vestPrice:174.88,sharesHeld:391,taxShares:229},{id:"845fac77",vestDate:"2025-12-21",shares:630,vestPrice:184.97,sharesHeld:398,taxShares:232},{id:"fd382eb7",vestDate:"2026-03-21",shares:630,vestPrice:181.93,sharesHeld:113,taxShares:267,salePrice:173.69},{id:"084b0b42",vestDate:"2026-06-21",shares:190,vestPrice:207.41,sharesHeld:120,taxShares:70},
    ]},
    { id:"d40e8493", ticker:"NVDA", grantDate:"2022-09-01", totalShares:3500, grantPrice:31.159, vests:[
      {id:"65e727ed",vestDate:"2023-09-21",shares:240,vestPrice:42.24,sharesHeld:150,taxShares:90},{id:"7dd121d9",vestDate:"2023-12-21",shares:240,vestPrice:48.09,sharesHeld:150,taxShares:90},{id:"8185b9e9",vestDate:"2024-03-21",shares:240,vestPrice:90.37,sharesHeld:0,taxShares:110,salePrice:132.25},{id:"85aa96e6",vestDate:"2024-06-21",shares:240,vestPrice:135.58,sharesHeld:0,taxShares:89,salePrice:132.25},{id:"318bd367",vestDate:"2024-09-21",shares:240,vestPrice:115.59,sharesHeld:0,taxShares:89,salePrice:132.25},{id:"30b76695",vestDate:"2024-12-21",shares:240,vestPrice:135.07,sharesHeld:59,taxShares:89,salePrice:120.00},{id:"b5f5162e",vestDate:"2025-03-21",shares:240,vestPrice:115.43,sharesHeld:136,taxShares:104},{id:"9b31c159",vestDate:"2025-06-21",shares:250,vestPrice:144.12,sharesHeld:158,taxShares:92},{id:"ac672de7",vestDate:"2025-09-21",shares:240,vestPrice:174.88,sharesHeld:151,taxShares:89},{id:"616c7d6b",vestDate:"2025-12-21",shares:240,vestPrice:184.97,sharesHeld:151,taxShares:89},{id:"0e83f19d",vestDate:"2026-03-21",shares:240,vestPrice:181.93,sharesHeld:0,taxShares:91,salePrice:173.69},{id:"f88bee65",vestDate:"2026-06-21",shares:240,vestPrice:207.41,sharesHeld:151,taxShares:89},
    ]},
    { id:"c450e6fa", ticker:"NVDA", grantDate:"2023-09-01", totalShares:1350, grantPrice:89.82, vests:[
      {id:"0fa3a574",vestDate:"2024-09-21",shares:100,vestPrice:115.59,sharesHeld:0,taxShares:38,salePrice:132.25},{id:"7bf3689a",vestDate:"2024-12-21",shares:100,vestPrice:135.07,sharesHeld:0,taxShares:38,salePrice:120.00},{id:"0a14edb4",vestDate:"2025-03-21",shares:110,vestPrice:115.43,sharesHeld:63,taxShares:47},{id:"cf79605c",vestDate:"2025-06-21",shares:100,vestPrice:144.12,sharesHeld:62,taxShares:38},{id:"602e05f6",vestDate:"2025-09-21",shares:100,vestPrice:174.88,sharesHeld:62,taxShares:38},{id:"651292bf",vestDate:"2025-12-21",shares:110,vestPrice:184.97,sharesHeld:68,taxShares:42},{id:"1fed9de5",vestDate:"2026-03-21",shares:100,vestPrice:181.93,sharesHeld:49,taxShares:39,salePrice:173.69},{id:"17f2e01a",vestDate:"2026-06-21",shares:110,vestPrice:207.41,sharesHeld:68,taxShares:42},
    ]},
    { id:"e7c47488", ticker:"NVDA", grantDate:"2024-06-01", totalShares:617, grantPrice:129.59, vests:[
      {id:"94c33088",vestDate:"2025-06-21",shares:53,vestPrice:144.12,sharesHeld:33,taxShares:20},{id:"29cc397f",vestDate:"2025-09-21",shares:53,vestPrice:174.88,sharesHeld:33,taxShares:20},{id:"60bf3c8d",vestDate:"2025-12-21",shares:53,vestPrice:184.97,sharesHeld:33,taxShares:20},{id:"cece266b",vestDate:"2026-03-21",shares:53,vestPrice:181.93,sharesHeld:32,taxShares:21,salePrice:173.69},{id:"cb746e23",vestDate:"2026-06-21",shares:53,vestPrice:207.41,sharesHeld:33,taxShares:20},
    ]},
    { id:"dc8b606f", ticker:"NVDA", grantDate:"2025-06-01", totalShares:382, grantPrice:185.81, vests:[
      {id:"0211c53a",vestDate:"2026-06-21",shares:37,vestPrice:207.41,sharesHeld:23,taxShares:14},
    ]},
  ] as import("@/lib/vault-types").RsuGrant[],
  esppPurchases: [
    {id:"fed55379",ticker:"NVDA",offeringDate:"2022-02-01",purchaseDate:"2022-02-01",shares:130,offeringPrice:20.728,purchasePrice:17.619,marketPriceAtPurchase:24.39,sharesHeld:130},
    {id:"e5983d47",ticker:"NVDA",offeringDate:"2022-08-22",purchaseDate:"2022-08-22",shares:920,offeringPrice:12.83,purchasePrice:10.906,marketPriceAtPurchase:15.09,sharesHeld:920},
    {id:"860d2e21",ticker:"NVDA",offeringDate:"2023-02-23",purchaseDate:"2023-02-23",shares:1100,offeringPrice:11.8465,purchasePrice:10.070,marketPriceAtPurchase:13.94,sharesHeld:1100},
    {id:"49758ba7",ticker:"NVDA",offeringDate:"2023-08-22",purchaseDate:"2023-08-22",shares:690,offeringPrice:11.8465,purchasePrice:10.070,marketPriceAtPurchase:13.94,sharesHeld:690},
    {id:"81de0cd4",ticker:"NVDA",offeringDate:"2024-02-23",purchaseDate:"2024-02-23",shares:1200,offeringPrice:11.8465,purchasePrice:10.070,marketPriceAtPurchase:13.94,sharesHeld:1200},
    {id:"26aeaf3b",ticker:"NVDA",offeringDate:"2024-08-31",purchaseDate:"2024-08-31",shares:593,offeringPrice:11.8465,purchasePrice:10.070,marketPriceAtPurchase:13.94,sharesHeld:593},
    {id:"c12df0c7",ticker:"NVDA",offeringDate:"2025-02-28",purchaseDate:"2025-02-28",shares:167,offeringPrice:91.8,purchasePrice:78.03,marketPriceAtPurchase:108.00,sharesHeld:167},
    {id:"5cd6c682",ticker:"NVDA",offeringDate:"2025-08-31",purchaseDate:"2025-08-31",shares:64,offeringPrice:91.8,purchasePrice:78.03,marketPriceAtPurchase:108.00,sharesHeld:64},
    {id:"a52cf6bb",ticker:"NVDA",offeringDate:"2026-02-28",purchaseDate:"2026-02-28",shares:184,offeringPrice:91.8,purchasePrice:78.03,marketPriceAtPurchase:108.00,sharesHeld:184},
    {id:"b73e9d1f",ticker:"NVDA",offeringDate:"2026-08-31",purchaseDate:"2026-08-31",shares:47,offeringPrice:91.8,purchasePrice:78.03,marketPriceAtPurchase:108.00,sharesHeld:47},
  ] as import("@/lib/vault-types").EsppPurchase[],
};

const BLANK_GRANT = { ticker: "NVDA", grantDate: "", totalShares: "", grantPrice: "" };
const BLANK_VEST = { vestDate: "", shares: "", vestPrice: "", sharesHeld: "" };
const BLANK_ESPP = {
  ticker: "NVDA",
  offeringDate: "",
  purchaseDate: "",
  shares: "",
  offeringPrice: "",
  purchasePrice: "",
  marketPriceAtPurchase: "",
  sharesHeld: "",
};

interface EquityReportProps {
  grants: RsuGrant[];
  esppPurchases: EsppPurchase[];
  onSave: (grants: RsuGrant[], espp: EsppPurchase[]) => Promise<void>;
  fmt: (n: number) => string;
  readOnly?: boolean;
}

export function EquityReport({ grants, esppPurchases, onSave, fmt, readOnly }: EquityReportProps) {
  const [price, setPrice] = useState<number | null>(null);
  const [priceErr, setPriceErr] = useState("");
  const [priceLoading, setPriceLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const [showAddGrant, setShowAddGrant] = useState(false);
  const [editGrant, setEditGrant] = useState<RsuGrant | null>(null);
  const [grantForm, setGrantForm] = useState(BLANK_GRANT);

  const [addVestFor, setAddVestFor] = useState<string | null>(null);
  const [vestForm, setVestForm] = useState(BLANK_VEST);

  const [showAddEspp, setShowAddEspp] = useState(false);
  const [esppForm, setEsppForm] = useState(BLANK_ESPP);

  const [summaryFilter, setSummaryFilter] = useState<"vested" | "tax" | "sold" | "espp" | null>(null);

  // ── Inline edit state (Mark Sold) ─────────────────────────────────────────
  const [editVest, setEditVest] = useState<{ grantId: string; vestId: string } | null>(null);
  const [editVestForm, setEditVestForm] = useState({ sharesHeld: "", taxShares: "", salePrice: "" });
  const [editEsppId, setEditEsppId] = useState<string | null>(null);
  const [editEsppForm, setEditEsppForm] = useState({ sharesHeld: "", salePrice: "" });

  const fetchPrice = useCallback(async () => {
    setPriceLoading(true);
    setPriceErr("");
    try {
      const res = await fetch("/api/equity-price?ticker=NVDA");
      const { price: p, error } = (await res.json()) as { price: number | null; error?: string };
      if (typeof p !== "number") throw new Error(error ?? "No price");
      setPrice(p);
    } catch {
      setPriceErr("Live price unavailable");
    } finally {
      setPriceLoading(false);
    }
  }, []);

  useEffect(() => { fetchPrice(); }, [fetchPrice]);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  const cur = price ?? 0;

  // ── RSU computations ──────────────────────────────────────────────────────
  const grantRows = grants.map((g) => {
    const vestedShares = g.vests.reduce((s, v) => s + v.shares, 0);
    const unvestedShares = Math.max(0, g.totalShares - vestedShares);
    const awardValue = g.totalShares * g.grantPrice;
    const vestedValue = g.vests.reduce((s, v) => s + v.shares * v.vestPrice, 0);
    // Tax withheld by company (goes to government — excluded from user gain)
    const taxValue = g.vests.reduce((s, v) => s + (v.taxShares ?? 0) * v.vestPrice, 0);
    // User-initiated sales only
    const saleValue = g.vests.reduce((s, v) => {
      const tax = v.taxShares ?? 0;
      const userSold = Math.max(0, v.shares - tax - v.sharesHeld);
      return s + userSold * (v.salePrice ?? v.vestPrice);
    }, 0);
    // Unrealized: held shares + unvested at live price
    const marketValue = g.vests.reduce((s, v) => s + v.sharesHeld * cur, 0) + unvestedShares * cur;
    const currentValue = saleValue + marketValue;
    const gain = currentValue - awardValue;
    return { ...g, vestedShares, unvestedShares, awardValue, vestedValue, taxValue, saleValue, marketValue, currentValue, gain };
  });
  const rsuAward = grantRows.reduce((s, g) => s + g.awardValue, 0);
  const rsuVested = grantRows.reduce((s, g) => s + g.vestedValue, 0);
  const rsuTaxValue = grantRows.reduce((s, g) => s + g.taxValue, 0);
  const rsuSaleValue = grantRows.reduce((s, g) => s + g.saleValue, 0); // user-sold only
  const rsuMarketValue = grantRows.reduce((s, g) => s + g.marketValue, 0);
  const rsuCurrent = rsuSaleValue + rsuMarketValue;
  const rsuGain = grantRows.reduce((s, g) => s + g.gain, 0);

  // Share counts for reconciliation
  const rsuHeldShares = grantRows.reduce((s, g) => s + g.vests.reduce((vs, v) => vs + v.sharesHeld, 0), 0);
  const rsuTaxShares = grantRows.reduce((s, g) => s + g.vests.reduce((vs, v) => vs + (v.taxShares ?? 0), 0), 0);
  const rsuUserSoldShares = grantRows.reduce((s, g) => s + g.vests.reduce((vs, v) => vs + Math.max(0, v.shares - (v.taxShares ?? 0) - v.sharesHeld), 0), 0);
  const rsuUnvestedShares = grantRows.reduce((s, g) => s + g.unvestedShares, 0);

  // ── ESPP computations ─────────────────────────────────────────────────────
  const esppRows = esppPurchases.map((e) => {
    const held = e.sharesHeld || e.shares;
    const sold = e.shares - held;
    const saleVal = sold * ((e as { salePrice?: number }).salePrice ?? e.marketPriceAtPurchase);
    const mktVal = held * cur;
    const purchaseValue = e.shares * e.offeringPrice;
    const gain = saleVal + mktVal - purchaseValue;
    return {
      ...e,
      sharesHeld: held,
      awardValue: e.shares * e.offeringPrice,
      vestedValue: e.shares * e.marketPriceAtPurchase,
      saleValue: saleVal,
      marketValue: mktVal,
      purchaseValue,
      gain,
      currentValue: saleVal + mktVal,
    };
  });
  const esppAward = esppRows.reduce((s, e) => s + e.awardValue, 0);
  const esppVested = esppRows.reduce((s, e) => s + e.vestedValue, 0);
  const esppCurrent = esppRows.reduce((s, e) => s + e.currentValue, 0);
  const esppHeldShares = esppRows.reduce((s, e) => s + e.sharesHeld, 0);

  // ── Summary bar values ────────────────────────────────────────────────────
  const summaryVestedValue = cur > 0
    ? grantRows.reduce((s, g) => s + g.vests.reduce((vs, v) => vs + v.sharesHeld * cur, 0), 0)
    : 0;
  const summaryTaxValue = grantRows.reduce((s, g) =>
    s + g.vests.reduce((vs, v) => vs + (v.taxShares ?? 0) * v.vestPrice, 0), 0);
  const summarySoldValue = grantRows.reduce((s, g) =>
    s + g.vests.reduce((vs, v) => {
      const tax = v.taxShares ?? 0;
      const sold = Math.max(0, v.shares - tax - v.sharesHeld);
      return vs + sold * (v.salePrice ?? v.vestPrice);
    }, 0), 0);
  const summaryEsppValue = cur > 0 ? esppRows.reduce((s, e) => s + e.sharesHeld * cur, 0) : 0;

  // Group ESPP by offering price, sorted by earliest purchase date (oldest first)
  const esppCycleMap = new Map<number, typeof esppRows[0][]>();
  for (const e of esppRows) {
    if (!esppCycleMap.has(e.offeringPrice)) esppCycleMap.set(e.offeringPrice, []);
    esppCycleMap.get(e.offeringPrice)!.push(e);
  }
  const esppCycles = Array.from(esppCycleMap.entries())
    .sort(([, ra], [, rb]) => {
      const ea = [...ra].sort((a, b) => a.purchaseDate.localeCompare(b.purchaseDate))[0]?.purchaseDate ?? "";
      const eb = [...rb].sort((a, b) => a.purchaseDate.localeCompare(b.purchaseDate))[0]?.purchaseDate ?? "";
      return ea.localeCompare(eb);
    })
    .map(([offeringPrice, rows]) => ({
      key: String(offeringPrice),
      offeringPrice,
      rows: [...rows].sort((a, b) => a.purchaseDate.localeCompare(b.purchaseDate)),
      totalShares: rows.reduce((s, r) => s + r.shares, 0),
      totalAward: rows.reduce((s, r) => s + r.awardValue, 0),
      totalVested: rows.reduce((s, r) => s + r.vestedValue, 0),
      totalHeld: rows.reduce((s, r) => s + r.sharesHeld, 0),
      totalPurchaseValue: rows.reduce((s, r) => s + r.purchaseValue, 0),
      totalSaleValue: rows.reduce((s, r) => s + r.saleValue, 0),
      totalCurrent: rows.reduce((s, r) => s + r.currentValue, 0),
      totalGain: rows.reduce((s, r) => s + r.gain, 0),
    }));

  // ── Save helpers ──────────────────────────────────────────────────────────
  async function doSave(g: RsuGrant[], e: EsppPurchase[]) {
    setSaving(true);
    try { await onSave(g, e); } finally { setSaving(false); }
  }

  async function saveGrant() {
    const g: RsuGrant = {
      id: editGrant?.id ?? uid(),
      ticker: grantForm.ticker || "NVDA",
      grantDate: grantForm.grantDate,
      totalShares: Number(grantForm.totalShares),
      grantPrice: Number(grantForm.grantPrice),
      vests: editGrant?.vests ?? [],
    };
    const next = editGrant ? grants.map((x) => (x.id === g.id ? g : x)) : [...grants, g];
    await doSave(next, esppPurchases);
    setShowAddGrant(false);
    setEditGrant(null);
    setGrantForm(BLANK_GRANT);
  }

  async function deleteGrant(id: string) {
    if (!confirm("Delete this RSU grant and all its vesting records?")) return;
    await doSave(grants.filter((g) => g.id !== id), esppPurchases);
  }

  async function saveVest() {
    if (!addVestFor) return;
    const vest: RsuVest = {
      id: uid(),
      vestDate: vestForm.vestDate,
      shares: Number(vestForm.shares),
      vestPrice: Number(vestForm.vestPrice),
      sharesHeld: vestForm.sharesHeld !== "" ? Number(vestForm.sharesHeld) : Number(vestForm.shares),
    };
    const next = grants.map((g) =>
      g.id === addVestFor
        ? { ...g, vests: [...g.vests, vest].sort((a, b) => a.vestDate.localeCompare(b.vestDate)) }
        : g
    );
    await doSave(next, esppPurchases);
    setAddVestFor(null);
    setVestForm(BLANK_VEST);
  }

  async function deleteVest(grantId: string, vestId: string) {
    const next = grants.map((g) =>
      g.id === grantId ? { ...g, vests: g.vests.filter((v) => v.id !== vestId) } : g
    );
    await doSave(next, esppPurchases);
  }

  async function saveVestEdit() {
    if (!editVest) return;
    const held = editVestForm.sharesHeld !== "" ? Number(editVestForm.sharesHeld) : undefined;
    const tax = editVestForm.taxShares !== "" ? Number(editVestForm.taxShares) : undefined;
    const sp = editVestForm.salePrice !== "" ? Number(editVestForm.salePrice) : undefined;
    const next = grants.map((g) =>
      g.id !== editVest.grantId ? g : {
        ...g,
        vests: g.vests.map((v) =>
          v.id !== editVest.vestId ? v : {
            ...v,
            sharesHeld: held ?? v.sharesHeld,
            taxShares: tax ?? v.taxShares,
            salePrice: sp,
          }
        ),
      }
    );
    await doSave(next, esppPurchases);
    setEditVest(null);
  }

  async function saveEsppEdit() {
    if (!editEsppId) return;
    const held = editEsppForm.sharesHeld !== "" ? Number(editEsppForm.sharesHeld) : undefined;
    const sp = editEsppForm.salePrice !== "" ? Number(editEsppForm.salePrice) : undefined;
    const next = esppPurchases.map((e) =>
      e.id !== editEsppId ? e : {
        ...e,
        sharesHeld: held ?? e.sharesHeld,
        salePrice: sp,
      }
    );
    await doSave(grants, next);
    setEditEsppId(null);
  }

  async function saveEspp() {
    const e: EsppPurchase = {
      id: uid(),
      ticker: esppForm.ticker || "NVDA",
      offeringDate: esppForm.offeringDate,
      purchaseDate: esppForm.purchaseDate,
      shares: Number(esppForm.shares),
      offeringPrice: Number(esppForm.offeringPrice),
      purchasePrice: Number(esppForm.purchasePrice),
      marketPriceAtPurchase: Number(esppForm.marketPriceAtPurchase),
      sharesHeld: esppForm.sharesHeld !== "" ? Number(esppForm.sharesHeld) : Number(esppForm.shares),
    };
    const next = [...esppPurchases, e].sort((a, b) => a.purchaseDate.localeCompare(b.purchaseDate));
    await doSave(grants, next);
    setShowAddEspp(false);
    setEsppForm(BLANK_ESPP);
  }

  async function deleteEspp(id: string) {
    if (!confirm("Delete this ESPP purchase?")) return;
    await doSave(grants, esppPurchases.filter((e) => e.id !== id));
  }

  return (
    <div className="data-panel equity-report">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="equity-header">
        <div className="equity-title-row">
          <h3>Equity Holdings — RSU &amp; ESPP</h3>
          <div className="equity-price-row">
            {priceLoading && <span className="equity-price-loading">Fetching NVDA…</span>}
            {!priceLoading && price !== null && (
              <span className="equity-price">
                NVDA <strong>${price.toFixed(2)}</strong>
              </span>
            )}
            {!priceLoading && priceErr && <span className="equity-price-err">{priceErr}</span>}
            <button className="equity-refresh" onClick={fetchPrice} disabled={priceLoading}>
              ↻ Refresh price
            </button>
          </div>
        </div>
        <div className="equity-summary-row">
          {(["vested", "tax", "sold", "espp"] as const).map((key) => {
            const labels = { vested: "Vested Value", tax: "Tax Value", sold: "Sold Value", espp: "ESPP Value" };
            const values = { vested: summaryVestedValue, tax: summaryTaxValue, sold: summarySoldValue, espp: summaryEsppValue };
            const subs = {
              vested: "RSU held shares @ live price",
              tax: "tax withheld lots @ vest FMV",
              sold: "user-sold lots @ sale price",
              espp: "ESPP held shares @ live price",
            };
            const active = summaryFilter === key;
            return (
              <button
                key={key}
                className={`equity-summary-card equity-summary-stat ${active ? "equity-summary-stat--active" : ""}`}
                onClick={() => setSummaryFilter(active ? null : key)}
              >
                <span>{labels[key]}</span>
                <strong className="equity-amt">{fmt(values[key])}</strong>
                <em>{subs[key]}</em>
              </button>
            );
          })}
        </div>

        {/* ── Drill-down panel ─────────────────────────────────────────── */}
        {summaryFilter && (
          <div className="equity-drilldown">
            <div className="equity-drilldown-head">
              <strong>
                {summaryFilter === "vested" && "RSU Vested Holdings"}
                {summaryFilter === "tax" && "Tax-Withheld Lots"}
                {summaryFilter === "sold" && "User-Sold Lots"}
                {summaryFilter === "espp" && "ESPP Holdings"}
              </strong>
              <button className="equity-drilldown-close" onClick={() => setSummaryFilter(null)}>✕ Close</button>
            </div>
            {(summaryFilter === "vested" || summaryFilter === "tax" || summaryFilter === "sold") && (
              <table className="equity-table equity-drilldown-table">
                <thead>
                  <tr>
                    <th>Grant</th>
                    <th>Vest Date</th>
                    {summaryFilter === "vested" && <><th className="right">Held Shares</th><th className="right">Live $/sh</th><th className="right">Market Value</th></>}
                    {summaryFilter === "tax" && <><th className="right">Tax Shares</th><th className="right">Vest $/sh</th><th className="right">Tax Value</th></>}
                    {summaryFilter === "sold" && <><th className="right">Sold Shares</th><th className="right">Sale $/sh</th><th className="right">Sale Value</th></>}
                  </tr>
                </thead>
                <tbody>
                  {grantRows.flatMap((g) =>
                    g.vests
                      .filter((v) => {
                        if (summaryFilter === "vested") return v.sharesHeld > 0;
                        if (summaryFilter === "tax") return (v.taxShares ?? 0) > 0;
                        const tax = v.taxShares ?? 0;
                        return Math.max(0, v.shares - tax - v.sharesHeld) > 0;
                      })
                      .map((v) => {
                        const tax = v.taxShares ?? 0;
                        const sold = Math.max(0, v.shares - tax - v.sharesHeld);
                        const sp = v.salePrice ?? v.vestPrice;
                        return (
                          <tr key={`${g.id}-${v.id}`}>
                            <td className="equity-neutral" style={{ fontSize: 11 }}>{g.ticker} {g.grantDate}</td>
                            <td>{new Date(v.vestDate).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}</td>
                            {summaryFilter === "vested" && (
                              <>
                                <td className="right">{v.sharesHeld.toLocaleString()}</td>
                                <td className="right">{cur > 0 ? `$${cur.toFixed(2)}` : "—"}</td>
                                <td className="right equity-gain-pos">{cur > 0 ? fmt(v.sharesHeld * cur) : "—"}</td>
                              </>
                            )}
                            {summaryFilter === "tax" && (
                              <>
                                <td className="right">{(v.taxShares ?? 0).toLocaleString()}</td>
                                <td className="right">${v.vestPrice.toFixed(2)}</td>
                                <td className="right">{fmt((v.taxShares ?? 0) * v.vestPrice)}</td>
                              </>
                            )}
                            {summaryFilter === "sold" && (
                              <>
                                <td className="right">{sold.toLocaleString()}</td>
                                <td className="right">${sp.toFixed(2)}{!v.salePrice ? " *" : ""}</td>
                                <td className="right">{fmt(sold * sp)}</td>
                              </>
                            )}
                          </tr>
                        );
                      })
                  )}
                </tbody>
                <tfoot>
                  <tr>
                    <th colSpan={2}>Total</th>
                    {summaryFilter === "vested" && (
                      <>
                        <th className="right">{rsuHeldShares.toLocaleString()}</th>
                        <th />
                        <th className="right equity-gain-pos">{fmt(summaryVestedValue)}</th>
                      </>
                    )}
                    {summaryFilter === "tax" && (
                      <>
                        <th className="right">{rsuTaxShares.toLocaleString()}</th>
                        <th />
                        <th className="right">{fmt(summaryTaxValue)}</th>
                      </>
                    )}
                    {summaryFilter === "sold" && (
                      <>
                        <th className="right">{rsuUserSoldShares.toLocaleString()}</th>
                        <th />
                        <th className="right">{fmt(summarySoldValue)}</th>
                      </>
                    )}
                  </tr>
                </tfoot>
              </table>
            )}
            {summaryFilter === "espp" && (
              <table className="equity-table equity-drilldown-table">
                <thead>
                  <tr>
                    <th>Purchase Date</th>
                    <th className="right">Held Shares</th>
                    <th className="right">Live $/sh</th>
                    <th className="right">Market Value</th>
                  </tr>
                </thead>
                <tbody>
                  {esppRows.filter(e => e.sharesHeld > 0).map((e) => (
                    <tr key={e.id}>
                      <td>{new Date(e.purchaseDate).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}</td>
                      <td className="right">{e.sharesHeld.toLocaleString()}</td>
                      <td className="right">{cur > 0 ? `$${cur.toFixed(2)}` : "—"}</td>
                      <td className="right equity-gain-pos">{cur > 0 ? fmt(e.sharesHeld * cur) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th>Total</th>
                    <th className="right">{esppHeldShares.toLocaleString()}</th>
                    <th />
                    <th className="right equity-gain-pos">{fmt(summaryEsppValue)}</th>
                  </tr>
                </tfoot>
              </table>
            )}
          </div>
        )}
        <div className="equity-share-counts">
          <span className="equity-share-chip equity-share-chip--held">RSU held: <strong>{rsuHeldShares.toLocaleString()}</strong> sh</span>
          <span className="equity-share-chip equity-share-chip--unvested">RSU unvested: <strong>{rsuUnvestedShares.toLocaleString()}</strong> sh</span>
          <span className="equity-share-chip equity-share-chip--tax">RSU tax withheld: <strong>{rsuTaxShares.toLocaleString()}</strong> sh</span>
          <span className="equity-share-chip equity-share-chip--sold">RSU sold: <strong>{rsuUserSoldShares.toLocaleString()}</strong> sh</span>
          <span className="equity-share-chip equity-share-chip--espp">ESPP held: <strong>{esppHeldShares.toLocaleString()}</strong> sh</span>
        </div>
      </div>

      {/* ── RSU Grants ─────────────────────────────────────────────────── */}
      <div className="equity-section-head">
        <h4>RSU Grants</h4>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          {!readOnly && grants.length > 0 && (
            <button
              className="equity-reload-btn"
              disabled={saving}
              onClick={async () => {
                if (!confirm("Reload NVIDIA seed data? This replaces all current RSU and ESPP entries with the latest seed (includes corrected taxShares).")) return;
                setSaving(true);
                try { await onSave(NVDA_SEED.grants, NVDA_SEED.esppPurchases); } finally { setSaving(false); }
              }}
            >
              ⟳ Reload NVIDIA data
            </button>
          )}
          {!readOnly && (
            <button
              onClick={() => {
                setShowAddGrant(true);
                setEditGrant(null);
                setGrantForm(BLANK_GRANT);
              }}
            >
              + Add Grant
            </button>
          )}
        </div>
      </div>

      {showAddGrant && (
        <div className="equity-form">
          <h5>{editGrant ? "Edit Grant" : "New RSU Grant"}</h5>
          <div className="equity-form-grid">
            <label>
              Grant Date
              <input
                type="date"
                value={grantForm.grantDate}
                onChange={(e) => setGrantForm((f) => ({ ...f, grantDate: e.target.value }))}
              />
            </label>
            <label>
              Total Shares Awarded
              <input
                type="number"
                value={grantForm.totalShares}
                onChange={(e) => setGrantForm((f) => ({ ...f, totalShares: e.target.value }))}
                placeholder="500"
              />
            </label>
            <label>
              Award Price (NVDA FMV on grant date)
              <input
                type="number"
                value={grantForm.grantPrice}
                onChange={(e) => setGrantForm((f) => ({ ...f, grantPrice: e.target.value }))}
                placeholder="218.40"
                step="0.01"
              />
            </label>
            <label>
              Ticker
              <input
                value={grantForm.ticker}
                onChange={(e) => setGrantForm((f) => ({ ...f, ticker: e.target.value }))}
              />
            </label>
          </div>
          <div className="equity-form-actions">
            <button onClick={saveGrant} disabled={saving || !grantForm.grantDate || !grantForm.totalShares || !grantForm.grantPrice}>
              {saving ? "Saving…" : "Save Grant"}
            </button>
            <button
              onClick={() => {
                setShowAddGrant(false);
                setEditGrant(null);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {grants.length === 0 && !showAddGrant && (
        <div className="equity-seed-banner">
          <p className="equity-empty">No RSU grants yet.</p>
          <button
            className="equity-seed-btn"
            onClick={async () => {
              setSaving(true);
              try { await onSave(NVDA_SEED.grants, NVDA_SEED.esppPurchases); } finally { setSaving(false); }
            }}
            disabled={saving}
          >
            {saving ? "Loading…" : "⚡ Load my NVIDIA equity data"}
          </button>
          <p className="equity-seed-note">
            Pre-populated from your Vesting Schedule — 6 RSU grants + 9 ESPP purchases. Review and adjust shares held after loading.
          </p>
        </div>
      )}

      {/* Grant header row */}
      {grants.length > 0 && (
        <div className="equity-grant-header">
          <span style={{ flex: 1 }}>Grant</span>
          <span className="equity-col-head">Award Value</span>
          <span className="equity-col-head">Sale Proceeds</span>
          <span className="equity-col-head">Market Value</span>
          <span className="equity-col-head equity-col-head--gain">Gain</span>
          <span style={{ width: 72 }} />
        </div>
      )}

      {grantRows.map((g) => (
        <div key={g.id} className="equity-grant">
          <div className="equity-grant-head" onClick={() => toggle(g.id)}>
            <span className="equity-arr">{expanded.has(g.id) ? "−" : "+"}</span>
            <span className="equity-grant-label">
              <strong>{g.ticker}</strong> granted {fmtDate(g.grantDate)}
              <em>
                {" "}
                — {g.totalShares.toLocaleString()} shares ({g.vestedShares.toLocaleString()} vested,{" "}
                {g.unvestedShares.toLocaleString()} unvested)
              </em>
            </span>
            <span className="equity-amt equity-col-val">{fmt(g.awardValue)}</span>
            <span className="equity-amt equity-col-val">{fmt(g.saleValue)}</span>
            <span className="equity-amt equity-col-val">{fmt(g.marketValue)}</span>
            <span className={`equity-col-val ${g.gain >= 0 ? "equity-gain-pos" : "equity-gain-neg"}`}>{fmt(g.gain)}</span>
            <div className="equity-grant-btns" onClick={(e) => e.stopPropagation()}>
              <button
                onClick={() => {
                  setEditGrant(g);
                  setGrantForm({
                    ticker: g.ticker,
                    grantDate: g.grantDate,
                    totalShares: String(g.totalShares),
                    grantPrice: String(g.grantPrice),
                  });
                  setShowAddGrant(true);
                }}
              >
                Edit
              </button>
              <button onClick={() => deleteGrant(g.id)}>✕</button>
            </div>
          </div>

          {expanded.has(g.id) && (
            <div className="equity-grant-body">
              <table className="equity-vest-table">
                <thead>
                  <tr>
                    <th>Vest Date</th>
                    <th className="right">Award $/sh</th>
                    <th className="right">Vest $/sh</th>
                    <th className="right">Total</th>
                    <th className="right">Tax</th>
                    <th className="right">Sold</th>
                    <th className="right">Sale $/sh</th>
                    <th className="right">Kept</th>
                    <th className="right">Sale Value</th>
                    <th className="right">Mkt Value</th>
                    <th className="right">Gain</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {g.vests.length === 0 && (
                    <tr>
                      <td colSpan={12} className="equity-empty-cell">No vesting records yet.</td>
                    </tr>
                  )}
                  {g.vests.map((v) => {
                    const sp = v.salePrice ?? v.vestPrice;
                    const mktVal = v.sharesHeld * cur;
                    const isEditing = editVest?.grantId === g.id && editVest?.vestId === v.id;
                    if (isEditing) {
                      return (
                        <tr key={v.id} className="equity-edit-row">
                          <td colSpan={8}>
                            <strong>{fmtDate(v.vestDate)}</strong> — {v.shares} shares @ award ${g.grantPrice.toFixed(2)}, vest ${v.vestPrice.toFixed(2)}
                            <span className="equity-edit-fields">
                              <label>Tax shares withheld
                                <input type="number" value={editVestForm.taxShares}
                                  onChange={e => setEditVestForm(f => ({...f, taxShares: e.target.value}))}
                                  placeholder={String(v.taxShares ?? 0)} min={0} max={v.shares} />
                              </label>
                              <label>Shares still held
                                <input type="number" value={editVestForm.sharesHeld}
                                  onChange={e => setEditVestForm(f => ({...f, sharesHeld: e.target.value}))}
                                  placeholder={String(v.sharesHeld)} min={0} max={v.shares} />
                              </label>
                              <label>Sale price $/sh (if sold)
                                <input type="number" value={editVestForm.salePrice}
                                  onChange={e => setEditVestForm(f => ({...f, salePrice: e.target.value}))}
                                  placeholder={v.salePrice ? String(v.salePrice) : "leave blank = use vest price"} step="0.01" />
                              </label>
                            </span>
                          </td>
                          <td colSpan={4} className="right">
                            <button onClick={saveVestEdit} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
                            {" "}
                            <button onClick={() => setEditVest(null)}>Cancel</button>
                          </td>
                        </tr>
                      );
                    }
                    const tax = v.taxShares ?? 0;
                    const userSold = Math.max(0, v.shares - tax - v.sharesHeld);
                    const userSaleVal = userSold * sp;
                    const vestGain = userSaleVal + mktVal - v.shares * g.grantPrice;
                    return (
                      <tr key={v.id}>
                        <td>{fmtDate(v.vestDate)}</td>
                        <td className="right equity-award-price">${g.grantPrice.toFixed(2)}</td>
                        <td className="right">${v.vestPrice.toFixed(2)}</td>
                        <td className="right">{v.shares.toLocaleString()}</td>
                        <td className="right">
                          {tax > 0 ? <span className="equity-tax-badge">{tax.toLocaleString()}</span> : <span className="equity-neutral">—</span>}
                        </td>
                        <td className="right">
                          {userSold > 0 ? <span className="equity-sold-badge">{userSold.toLocaleString()}</span> : <span className="equity-neutral">—</span>}
                        </td>
                        <td className="right">
                          {userSold > 0
                            ? <span title={v.salePrice ? "actual sale price" : "est. from vest price"}>${sp.toFixed(2)}{!v.salePrice && userSold > 0 ? " *" : ""}</span>
                            : <span className="equity-neutral">—</span>}
                        </td>
                        <td className="right">
                          {v.sharesHeld > 0 ? <span className="equity-kept-badge">{v.sharesHeld.toLocaleString()}</span> : <span className="equity-neutral">—</span>}
                        </td>
                        <td className="right">{userSaleVal > 0 ? fmt(userSaleVal) : <span className="equity-neutral">—</span>}</td>
                        <td className="right">{v.sharesHeld > 0 ? fmt(mktVal) : <span className="equity-neutral">—</span>}</td>
                        <td className={`right ${vestGain >= 0 ? "equity-gain-pos" : "equity-gain-neg"}`}>{fmt(vestGain)}</td>
                        <td>
                          {!readOnly && (<><button className="equity-edit-btn" title="Mark sold / update" onClick={() => {
                            setEditVest({ grantId: g.id, vestId: v.id });
                            setEditVestForm({ sharesHeld: String(v.sharesHeld), taxShares: String(tax), salePrice: v.salePrice ? String(v.salePrice) : "" });
                          }}>✎</button>
                          {" "}
                          <button className="equity-del-btn" onClick={() => deleteVest(g.id, v.id)}>✕</button></>)}
                        </td>
                      </tr>
                    );
                  })}
                  {g.unvestedShares > 0 && (
                    <tr className="equity-unvested-row">
                      <td><em>Unvested →</em></td>
                      <td className="right equity-award-price">${g.grantPrice.toFixed(2)}</td>
                      <td className="right">—</td>
                      <td className="right equity-kept-badge">{g.unvestedShares.toLocaleString()}</td>
                      <td className="right">—</td>
                      <td className="right">—</td>
                      <td className="right">—</td>
                      <td className="right">—</td>
                      <td className="right">—</td>
                      <td className="right">{fmt(g.unvestedShares * cur)}</td>
                      <td className={`right ${g.unvestedShares * (cur - g.grantPrice) >= 0 ? "equity-gain-pos" : "equity-gain-neg"}`}>
                        {fmt(g.unvestedShares * (cur - g.grantPrice))}
                      </td>
                      <td />
                    </tr>
                  )}
                </tbody>
              </table>

              {addVestFor === g.id ? (
                <div className="equity-form equity-vest-form">
                  <h5>Record Vesting Event</h5>
                  <div className="equity-form-grid">
                    <label>
                      Vest Date
                      <input
                        type="date"
                        value={vestForm.vestDate}
                        onChange={(e) => setVestForm((f) => ({ ...f, vestDate: e.target.value }))}
                      />
                    </label>
                    <label>
                      Shares Vested
                      <input
                        type="number"
                        value={vestForm.shares}
                        onChange={(e) => setVestForm((f) => ({ ...f, shares: e.target.value }))}
                      />
                    </label>
                    <label>
                      NVDA Price on Vest Date
                      <input
                        type="number"
                        value={vestForm.vestPrice}
                        onChange={(e) => setVestForm((f) => ({ ...f, vestPrice: e.target.value }))}
                        step="0.01"
                      />
                    </label>
                    <label>
                      Shares Still Held (blank = all)
                      <input
                        type="number"
                        value={vestForm.sharesHeld}
                        onChange={(e) =>
                          setVestForm((f) => ({ ...f, sharesHeld: e.target.value }))
                        }
                      />
                    </label>
                  </div>
                  <div className="equity-form-actions">
                    <button
                      onClick={saveVest}
                      disabled={saving || !vestForm.vestDate || !vestForm.shares || !vestForm.vestPrice}
                    >
                      {saving ? "Saving…" : "Add Vesting Event"}
                    </button>
                    <button onClick={() => setAddVestFor(null)}>Cancel</button>
                  </div>
                </div>
              ) : (
                !readOnly && (
                  <button
                    className="equity-add-vest-btn"
                    onClick={() => {
                      setAddVestFor(g.id);
                      setVestForm(BLANK_VEST);
                    }}
                  >
                    + Add Vesting Event
                  </button>
                )
              )}
            </div>
          )}
        </div>
      ))}

      {/* RSU total row */}
      {grants.length > 0 && (
        <div className="equity-section-total">
          <span>RSU Total</span>
          <span className="equity-amt equity-col-val">{fmt(rsuAward)}</span>
          <span className="equity-amt equity-col-val">{fmt(rsuSaleValue)}</span>
          <span className="equity-amt equity-col-val">{fmt(rsuMarketValue)}</span>
          <span className={`equity-col-val ${rsuGain >= 0 ? "equity-gain-pos" : "equity-gain-neg"}`}>{fmt(rsuGain)}</span>
          <span style={{ width: 72 }} />
        </div>
      )}

      {/* ── ESPP Purchases ─────────────────────────────────────────────── */}
      <div className="equity-section-head" style={{ marginTop: "2rem" }}>
        <h4>ESPP Purchases</h4>
        {!readOnly && <button onClick={() => setShowAddEspp(true)}>+ Add Purchase</button>}
      </div>

      {showAddEspp && (
        <div className="equity-form">
          <h5>New ESPP Purchase</h5>
          <div className="equity-form-grid">
            <label>
              Offering Date (period start)
              <input
                type="date"
                value={esppForm.offeringDate}
                onChange={(e) => setEsppForm((f) => ({ ...f, offeringDate: e.target.value }))}
              />
            </label>
            <label>
              Purchase Date
              <input
                type="date"
                value={esppForm.purchaseDate}
                onChange={(e) => setEsppForm((f) => ({ ...f, purchaseDate: e.target.value }))}
              />
            </label>
            <label>
              Shares Purchased
              <input
                type="number"
                value={esppForm.shares}
                onChange={(e) => setEsppForm((f) => ({ ...f, shares: e.target.value }))}
              />
            </label>
            <label>
              Offering Price (NVDA FMV at period start)
              <input
                type="number"
                value={esppForm.offeringPrice}
                onChange={(e) => setEsppForm((f) => ({ ...f, offeringPrice: e.target.value }))}
                step="0.01"
              />
            </label>
            <label>
              Purchase Price (price you paid)
              <input
                type="number"
                value={esppForm.purchasePrice}
                onChange={(e) => setEsppForm((f) => ({ ...f, purchasePrice: e.target.value }))}
                step="0.01"
              />
            </label>
            <label>
              NVDA FMV at Purchase Date
              <input
                type="number"
                value={esppForm.marketPriceAtPurchase}
                onChange={(e) =>
                  setEsppForm((f) => ({ ...f, marketPriceAtPurchase: e.target.value }))
                }
                step="0.01"
              />
            </label>
            <label>
              Shares Still Held (blank = all)
              <input
                type="number"
                value={esppForm.sharesHeld}
                onChange={(e) => setEsppForm((f) => ({ ...f, sharesHeld: e.target.value }))}
              />
            </label>
            <label>
              Ticker
              <input
                value={esppForm.ticker}
                onChange={(e) => setEsppForm((f) => ({ ...f, ticker: e.target.value }))}
              />
            </label>
          </div>
          <div className="equity-form-actions">
            <button
              onClick={saveEspp}
              disabled={
                saving ||
                !esppForm.offeringDate ||
                !esppForm.purchaseDate ||
                !esppForm.shares ||
                !esppForm.purchasePrice
              }
            >
              {saving ? "Saving…" : "Save Purchase"}
            </button>
            <button onClick={() => setShowAddEspp(false)}>Cancel</button>
          </div>
        </div>
      )}

      {esppPurchases.length === 0 && !showAddEspp && (
        <p className="equity-empty">No ESPP purchases yet. Click "+ Add Purchase" to begin.</p>
      )}

      {esppCycles.length > 0 && (
        <table className="equity-espp-table">
          <thead>
            <tr>
              <th>ESPP Cycle / Purchase</th>
              <th className="right">Shares</th>
              <th className="right">Purchase $/sh</th>
              <th className="right">FMV $/sh</th>
              <th className="right">Sold</th>
              <th className="right">Held</th>
              <th className="right">Purch Value</th>
              <th className="right">Sale Value</th>
              <th className="right">Market Value</th>
              <th className="right">Gain</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {esppCycles.flatMap((cycle) => {
              const cyclePurchasePrice = cycle.offeringPrice;
              const cycleFMV = cycle.rows[0]?.marketPriceAtPurchase ?? 0;
              return [
              <tr
                key={`cycle-hdr-${cycle.key}`}
                className="equity-cycle-row"
                onClick={() => toggle(`espp-${cycle.key}`)}
              >
                <td>
                  <span className="equity-arr">{expanded.has(`espp-${cycle.key}`) ? "−" : "+"}</span>
                  {" "}Offering @ <strong>${cycle.offeringPrice.toFixed(2)}</strong>
                  <em> — {cycle.rows.length} purchase{cycle.rows.length > 1 ? "s" : ""}</em>
                </td>
                <td className="right">{cycle.totalShares.toLocaleString()}</td>
                <td className="right">${cyclePurchasePrice.toFixed(2)}</td>
                <td className="right">${cycleFMV.toFixed(2)}</td>
                <td className="right">{(cycle.totalShares - cycle.totalHeld) > 0 ? <span className="equity-sold-badge">{(cycle.totalShares - cycle.totalHeld).toLocaleString()}</span> : <span className="equity-neutral">—</span>}</td>
                <td className="right"><span className="equity-kept-badge">{cycle.totalHeld.toLocaleString()}</span></td>
                <td className="right equity-amt">{fmt(cycle.totalPurchaseValue)}</td>
                <td className="right equity-amt">{fmt(cycle.totalSaleValue)}</td>
                <td className="right equity-amt">{fmt(cycle.totalCurrent)}</td>
                <td className={`right ${cycle.totalGain >= 0 ? "equity-gain-pos" : "equity-gain-neg"}`}>{fmt(cycle.totalGain)}</td>
                <td />
              </tr>,
              ...(expanded.has(`espp-${cycle.key}`)
                ? cycle.rows.map((e) => {
                    const eSold = e.shares - e.sharesHeld;
                    const isEditingEspp = editEsppId === e.id;
                    if (isEditingEspp) {
                      return (
                        <tr key={e.id} className="equity-edit-row">
                          <td colSpan={7} className="equity-cycle-indent">
                            <strong>{fmtDate(e.purchaseDate)}</strong> — {e.shares} shares @ ${e.purchasePrice.toFixed(2)}
                            <span className="equity-edit-fields">
                              <label>Shares still held
                                <input type="number" value={editEsppForm.sharesHeld}
                                  onChange={ev => setEditEsppForm(f => ({...f, sharesHeld: ev.target.value}))}
                                  placeholder={String(e.sharesHeld)} min={0} max={e.shares} />
                              </label>
                              <label>Sale price $/sh (if sold)
                                <input type="number" value={editEsppForm.salePrice}
                                  onChange={ev => setEditEsppForm(f => ({...f, salePrice: ev.target.value}))}
                                  placeholder="leave blank = use FMV" step="0.01" />
                              </label>
                            </span>
                          </td>
                          <td colSpan={4} className="right">
                            <button onClick={(ev) => { ev.stopPropagation(); saveEsppEdit(); }} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
                            {" "}
                            <button onClick={(ev) => { ev.stopPropagation(); setEditEsppId(null); }}>Cancel</button>
                          </td>
                        </tr>
                      );
                    }
                    return (
                      <tr key={e.id} className="equity-cycle-detail">
                        <td className="equity-cycle-indent">{fmtDate(e.purchaseDate)}</td>
                        <td className="right">{e.shares.toLocaleString()}</td>
                        <td className="right">${e.offeringPrice.toFixed(2)}</td>
                        <td className="right">${e.marketPriceAtPurchase.toFixed(2)}</td>
                        <td className="right">{eSold > 0 ? <span className="equity-sold-badge">{eSold.toLocaleString()}</span> : <span className="equity-neutral">—</span>}</td>
                        <td className="right"><span className="equity-kept-badge">{e.sharesHeld.toLocaleString()}</span></td>
                        <td className="right equity-amt">{fmt(e.purchaseValue)}</td>
                        <td className="right equity-amt">{eSold > 0 ? fmt(e.saleValue) : <span className="equity-neutral">—</span>}</td>
                        <td className="right equity-amt">{fmt(e.marketValue)}</td>
                        <td className={`right ${e.gain >= 0 ? "equity-gain-pos" : "equity-gain-neg"}`}>{fmt(e.gain)}</td>
                        <td>
                          {!readOnly && (<><button className="equity-edit-btn" title="Mark sold" onClick={(ev) => {
                            ev.stopPropagation();
                            setEditEsppId(e.id);
                            setEditEsppForm({ sharesHeld: String(e.sharesHeld), salePrice: (e as { salePrice?: number }).salePrice ? String((e as { salePrice?: number }).salePrice) : "" });
                          }}>✎</button>
                          {" "}
                          <button className="equity-del-btn" onClick={(ev) => { ev.stopPropagation(); deleteEspp(e.id); }}>✕</button></>)}
                        </td>
                      </tr>
                    );
                  })
                : []),
              ]; // end return
            })}
          </tbody>
          <tfoot>
            <tr>
              <th colSpan={4}>ESPP Total — {esppHeldShares.toLocaleString()} shares held</th>
              <th className="right">—</th>
              <th className="right">{esppHeldShares.toLocaleString()}</th>
              <th className="right equity-amt">{fmt(esppRows.reduce((s, e) => s + e.purchaseValue, 0))}</th>
              <th className="right equity-amt">{fmt(esppRows.reduce((s, e) => s + e.saleValue, 0))}</th>
              <th className="right equity-amt">{fmt(esppCurrent)}</th>
              <th className={`right ${esppRows.reduce((s, e) => s + e.gain, 0) >= 0 ? "equity-gain-pos" : "equity-gain-neg"}`}>{fmt(esppRows.reduce((s, e) => s + e.gain, 0))}</th>
              <th />
            </tr>
          </tfoot>
        </table>
      )}

      {/* ── Grand total ────────────────────────────────────────────────── */}
      {(grants.length > 0 || esppPurchases.length > 0) && (
        <div className="equity-grand-total">
          <span className="equity-grand-label">Grand Total</span>
          <div className="equity-grand-values">
            <div className="equity-grand-col">
              <span>Award Value</span>
              <strong className="equity-amt">{fmt(rsuAward + esppAward)}</strong>
            </div>
            <div className="equity-grand-col equity-grand-col--tax">
              <span>Tax Value</span>
              <strong className="equity-amt">{fmt(rsuTaxValue)}</strong>
              <em className="equity-grand-col-note">withheld → govt</em>
            </div>
            <div className="equity-grand-col">
              <span>Sale Proceeds</span>
              <strong className="equity-amt">{fmt(rsuSaleValue + esppRows.reduce((s, e) => s + e.saleValue, 0))}</strong>
            </div>
            <div className="equity-grand-col">
              <span>Market Value</span>
              <strong className="equity-amt">{fmt(rsuMarketValue + esppCurrent)}</strong>
            </div>
            <div className="equity-grand-col equity-grand-col--gain">
              <span>Total Gain</span>
              <strong className="equity-amt">{fmt((rsuCurrent + esppCurrent) - (rsuAward + esppAward))}</strong>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

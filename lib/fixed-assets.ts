import type { FixedAsset } from "./vault-types";

// Pure straight-line depreciation math -- deliberately free of any runtime import from another
// lib/*.ts file (only a type-only import above). node --test cannot resolve extensionless
// relative imports between two lib/*.ts files when the import carries actual runtime values (a
// pre-existing gap in this repo's test infra, hit before with lib/budget.ts and
// lib/multi-year-trend.ts) -- keeping this file import-free keeps it directly unit-testable.
// Ledger-mutating logic (posting Tx's, creating accounts) lives in lib/fixed-assets-ledger.ts,
// which imports these functions as values and is verified live instead.

export const FIXED_ASSETS_GROUP_NAME = "Fixed Assets";
export const EXPENSE_GROUP_NAME = "Indirect Expenses";
export const DEPRECIATION_EXPENSE_ACCOUNT_NAME = "Depreciation Expense";
export const ACCUMULATED_DEPRECIATION_ACCOUNT_NAME = "Accumulated Depreciation";

// SAP/Oracle-style asset class labels -- offered as datalist suggestions and used to order the
// grouped register view (any custom class the user types falls back to alphabetical order after
// these; "Unclassified" always sorts last).
export const ASSET_CLASS_SUGGESTIONS = [
  "Furniture & Fixtures",
  "Vehicles",
  "Electronics & Appliances",
  "IT Equipment",
  "Machinery & Equipment",
  "Buildings & Improvements",
];
export const UNCLASSIFIED_LABEL = "Unclassified";

// Sentinel passed to the ledger drill-down's tag filter for an asset with NO sourceTag (a legacy
// asset added before tagging existed, or a plain manual one). Since createTaggedAsset carves a
// tagged sibling's cost out of a legacy asset's cost (see fixed-assets-ledger.ts), the legacy
// asset's own total no longer equals the whole ledger once it has any tagged siblings -- so its
// drill-down needs to exclude every OTHER entry's tag too, not show the raw whole-ledger history.
export const UNTAGGED_ASSET_FILTER = "__untagged__";

// Best-effort keyword match from an asset's own name to one of the classes above -- checked in
// order, first match wins, so more specific categories (e.g. "washing machine") must be listed
// before broader ones (e.g. "machine") that would otherwise also match. Returns undefined rather
// than guessing when nothing matches, so a genuinely novel asset name isn't mis-tagged.
const ASSET_CLASS_RULES: { pattern: RegExp; assetClass: string }[] = [
  {
    pattern:
      /\b(activa|splendor|scooter|scooty|motorcycle|bullet|pulsar|apache|maruti|wagon\s*r|swift|innova|creta|nexon|verna|honda\s*city|jazz|amaze|thar|scorpio|alto|baleno|i20|i10|santro|figo|polo|vento|rapid|octavia|fortuner|xuv|ertiga|dzire|celerio|kwid|triber|venue|seltos|sonet|harrier|safari|tiago|tigor|punch)\b/i,
    assetClass: "Vehicles",
  },
  {
    pattern: /\b(mobile|smartphone|iphone|laptop|notebook|desktop|computer|tablet|ipad|printer|router|modem|monitor)\b/i,
    assetClass: "IT Equipment",
  },
  {
    pattern:
      /\b(refrigerator|fridge|washing machine|air condition(er)?|\bac\b|microwave|oven|food processor|mixture|grinder|mixer|television|\btv\b|geyser|water heater|cooler|vacuum|dishwasher|speaker|music system|\biron\b|key\s*board|casio|synthesizer|piano)\b/i,
    assetClass: "Electronics & Appliances",
  },
  {
    pattern: /\b(sofa|furniture|dining table|chair|\bbed\b|cupboard|wardrobe|almirah|shelf|cabinet)\b/i,
    assetClass: "Furniture & Fixtures",
  },
  {
    pattern: /\b(building|\bhouse\b|\bflat\b|apartment|renovation|construction)\b/i,
    assetClass: "Buildings & Improvements",
  },
  { pattern: /\b(machine|equipment|generator|\bpump\b|\btool\b)\b/i, assetClass: "Machinery & Equipment" },
];

export function guessAssetClass(name: string): string | undefined {
  for (const rule of ASSET_CLASS_RULES) if (rule.pattern.test(name)) return rule.assetClass;
  return undefined;
}

// SAP/Oracle-style: each Asset Class gets its own short number-range prefix, so the tag itself
// tells you the class at a glance (e.g. "VEH-003"). Same prefixes/logic in every book -- only the
// sequence within a prefix is book-local, since each book's vault is an independent store with no
// shared counter between them.
export const ASSET_CLASS_PREFIXES: Record<string, string> = {
  "Furniture & Fixtures": "FUR",
  Vehicles: "VEH",
  // "ELE", not "ELEC" -- matches the 3-letter convention already established across this book's
  // real, already-numbered Electronics & Appliances assets rather than inventing a longer one.
  "Electronics & Appliances": "ELE",
  // "MOB", not "IT" -- matches the convention already established across the real, already-
  // numbered IT Equipment assets (phones, tablets, laptops -- MOB-001, MOB-002, ...) in this
  // book, same as the ELE alias above.
  "IT Equipment": "MOB",
  "Machinery & Equipment": "MACH",
  "Buildings & Improvements": "BLDG",
  [UNCLASSIFIED_LABEL]: "MISC",
};

// SAP/Oracle-style: useful life is a property of the Asset Class, not something re-typed on every
// individual asset -- these are the book-wide defaults a new asset in Masters > Fixed Assets
// inherits from its Class, so "+ Add Asset" only needs a Name/Class/Tag, never a hand-typed
// depreciation period. Salvage value always defaults to 0 (no class commonly has a non-zero
// residual by default); both remain editable per-asset afterward if a specific item is different.
export const ASSET_CLASS_DEFAULT_LIFE_MONTHS: Record<string, number> = {
  "Furniture & Fixtures": 84,
  Vehicles: 60,
  "Electronics & Appliances": 60,
  "IT Equipment": 36,
  "Machinery & Equipment": 84,
  "Buildings & Improvements": 360,
  [UNCLASSIFIED_LABEL]: 60,
};

export function defaultUsefulLifeForClass(assetClass: string): number {
  return ASSET_CLASS_DEFAULT_LIFE_MONTHS[assetClass] ?? 60;
}

// Next sequential "PREFIX-NNN" tag not already present in `existingTags` (any tag under that
// prefix, case-insensitive, however it originated -- freehand or previously auto-suggested).
// Zero-padded to 3 digits up to 999, then grows naturally (e.g. "VEH-1000").
export function suggestNextAssetTag(existingTags: string[], prefix: string): string {
  const re = new RegExp(`^${prefix}-(\\d+)$`, "i");
  const used = existingTags.map((t) => re.exec(t.trim())?.[1]).filter((n): n is string => !!n).map(Number);
  const next = (used.length ? Math.max(...used) : 0) + 1;
  return `${prefix}-${String(next).padStart(3, "0")}`;
}

// Reverse of ASSET_CLASS_PREFIXES: the tag's own prefix already tells you which class it was
// assigned under (that's the whole point of class-prefixed numbering), so a synced asset's class
// can be derived straight from its tag instead of re-guessing from the ledger name or leaving it
// Unclassified until someone runs auto-classify by hand. Only matches the "PREFIX-NNN" shape --
// a freehand tag that doesn't follow the convention (e.g. typed before this scheme existed)
// correctly falls through to undefined, so the caller's own name-based guess still applies.
export function assetClassFromTag(tag: string): string | undefined {
  const prefix = /^([A-Za-z]+)-\d+$/.exec(tag.trim())?.[1]?.toUpperCase();
  if (!prefix) return undefined;
  for (const [cls, p] of Object.entries(ASSET_CLASS_PREFIXES)) if (p === prefix) return cls;
  return undefined;
}

// Straight-line monthly depreciation. usefulLifeMonths <= 0 is treated as "not depreciable"
// (e.g. land) -- returns 0 rather than dividing by zero/going negative.
export function monthlyDepreciation(asset: FixedAsset): number {
  if (asset.usefulLifeMonths <= 0) return 0;
  const depreciableBase = Math.max(0, asset.cost - asset.salvageValue);
  return round2(depreciableBase / asset.usefulLifeMonths);
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function ym(dateStr: string): string {
  return dateStr.slice(0, 7); // "YYYY-MM"
}

// Number of whole months between two "YYYY-MM" (or full date) strings.
export function monthsBetween(fromYm: string, toYm: string): number {
  const [fy, fm] = fromYm.split("-").map(Number);
  const [ty, tm] = toYm.split("-").map(Number);
  return (ty - fy) * 12 + (tm - fm);
}

export function addMonths(yearMonth: string, n: number): string {
  const [y, m] = yearMonth.split("-").map(Number);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, "0")}`;
}

// The date depreciation actually starts accruing from -- `inServiceDate` when set, else
// `purchaseDate`. Every depreciation calculation below must read the start date through this,
// never `asset.purchaseDate` directly, so a manual in-service override (see FixedAsset's own
// doc comment) is actually honored.
export function depreciationStartDate(asset: FixedAsset): string {
  return asset.inServiceDate || asset.purchaseDate;
}

// Accumulated depreciation as of asOfDate: whole months elapsed since the purchase month,
// capped at usefulLifeMonths and at the disposal month if disposed, capped again at the
// depreciable base so it never overshoots (rounding-safe).
//
// Once every month of the useful life has fully elapsed (asset not disposed early), this returns
// the depreciable base exactly rather than monthly * usefulLifeMonths -- that product can UNDERshoot
// the true base by a few cents (monthly is itself round2(depreciableBase / usefulLifeMonths), and
// that per-month rounding compounds over many months), which is exactly what a real last-period
// depreciation voucher is supposed to absorb so book value lands on precise $0.00 (or salvage), not
// a leftover residue. Mirrors pendingDepreciationMonths, whose own last posted month already caps
// at the true remaining balance rather than a flat `monthly` amount.
export function accumulatedDepreciation(asset: FixedAsset, asOfDate: string): number {
  const monthly = monthlyDepreciation(asset);
  if (monthly <= 0) return 0;
  const capDate = asset.disposed?.date && asset.disposed.date < asOfDate ? asset.disposed.date : asOfDate;
  let months = monthsBetween(ym(depreciationStartDate(asset)), ym(capDate));
  months = Math.max(0, Math.min(months, asset.usefulLifeMonths));
  const depreciableBase = Math.max(0, asset.cost - asset.salvageValue);
  if (months >= asset.usefulLifeMonths) return round2(depreciableBase);
  return Math.min(round2(monthly * months), depreciableBase);
}

export function bookValue(asset: FixedAsset, asOfDate: string): number {
  return round2(asset.cost - accumulatedDepreciation(asset, asOfDate));
}

// Months not yet posted (lastDepreciatedThrough exclusive) up through throughDate's month,
// capped at usefulLifeMonths total and at a disposal month if disposed. Each entry is one
// month's depreciation Tx to post. Strictly-before semantics (only fully-elapsed months count)
// so this always matches accumulatedDepreciation's own month count for the same asOfDate.
export function pendingDepreciationMonths(asset: FixedAsset, throughDate: string): { yearMonth: string; amount: number }[] {
  const monthly = monthlyDepreciation(asset);
  if (monthly <= 0) return [];
  const depStartYm = ym(depreciationStartDate(asset));
  const capYm = asset.disposed?.date ? ym(asset.disposed.date) : ym(throughDate);
  const throughYm = ym(throughDate) < capYm ? ym(throughDate) : capYm;
  const startYm = asset.lastDepreciatedThrough ? addMonths(asset.lastDepreciatedThrough, 1) : depStartYm;
  if (startYm >= throughYm) return [];

  const depreciableBase = Math.max(0, asset.cost - asset.salvageValue);
  const alreadyPosted = asset.lastDepreciatedThrough
    ? Math.min(round2(monthly * monthsBetween(depStartYm, addMonths(asset.lastDepreciatedThrough, 1))), depreciableBase)
    : 0;
  let remaining = round2(depreciableBase - alreadyPosted);

  const out: { yearMonth: string; amount: number }[] = [];
  let cursor = startYm;
  let monthIndex = monthsBetween(depStartYm, startYm);
  while (cursor < throughYm && monthIndex < asset.usefulLifeMonths && remaining > 0) {
    // The asset's very last useful-life month (this iteration is the last chance to ever post
    // against it) takes whatever's actually left, not a flat `monthly` amount -- monthly is
    // itself round2(depreciableBase / usefulLifeMonths), so usefulLifeMonths copies of it can
    // undershoot the true depreciable base by a few cents. Without this, a one-shot catch-up run
    // spanning the entire useful life in one go would post that residue as a permanent shortfall
    // (lastDepreciatedThrough advances past it, so nothing ever catches it up later) -- exactly
    // matching accumulatedDepreciation's own exact-at-full-term behavior above, so what actually
    // gets posted always agrees with what the report displays.
    const isFinalMonth = monthIndex === asset.usefulLifeMonths - 1;
    const amount = isFinalMonth ? remaining : Math.min(monthly, remaining);
    out.push({ yearMonth: cursor, amount });
    remaining = round2(remaining - amount);
    cursor = addMonths(cursor, 1);
    monthIndex++;
  }
  return out;
}

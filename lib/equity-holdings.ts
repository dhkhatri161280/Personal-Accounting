import type { RsuGrant, EsppPurchase } from "./vault-types";

/** Value of equity actually vested and still held right now (not yet sold), at a given live
 * price -- RSU shares held after tax withholding and any sales, plus ESPP shares still held.
 * Excludes pending/unvested RSU tranches (not vested yet, so not really "owned") and any shares
 * already sold (that cash is already reflected in the ledger). Mirrors EquityReport's "Vested
 * Value" + "ESPP Value" summary cards -- pass a USD price for a USD result, or price × FX rate
 * for an INR result (e.g. the GR consolidated book). */
export function computeHeldEquityValue(
  grants: RsuGrant[],
  esppPurchases: EsppPurchase[],
  livePrice: number
): { rsuValue: number; esppValue: number; totalValue: number } {
  if (!livePrice || livePrice <= 0) return { rsuValue: 0, esppValue: 0, totalValue: 0 };
  const rsuValue = grants.reduce(
    (s, g) => s + g.vests.filter((v) => !v.pending).reduce((vs, v) => vs + v.sharesHeld * livePrice, 0),
    0
  );
  const esppValue = esppPurchases.reduce((s, e) => s + (e.sharesHeld || e.shares) * livePrice, 0);
  return { rsuValue, esppValue, totalValue: rsuValue + esppValue };
}

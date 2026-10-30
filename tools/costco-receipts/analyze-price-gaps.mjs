#!/usr/bin/env node
// Reviews the real warehouse-vs-online gap observations check-prices.mjs has logged over time --
// no browser, no Costco calls, just reads .captures/price-gap-observations.json. Run this
// whenever you want to check whether a category has enough real data to justify a reviewed
// estimate, the same way the apparel-only $2 adjustment in check-prices.mjs was derived from a
// real, confirmed pattern rather than invented -- NOT something this script ever applies itself.
//
// Usage:
//   node analyze-price-gaps.mjs

import { loadGapObservations, printGapSummary } from "./gap-log.mjs";

const observations = loadGapObservations();
printGapSummary(observations);

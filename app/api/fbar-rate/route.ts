import { withEdgeCache } from "@/lib/edge-cache";

export const dynamic = "force-dynamic";

// Server-side proxy for the US Treasury's own Reporting Rates of Exchange (api.fiscaldata.treasury.gov),
// for the December 31 rate a calendar year's own FBAR filing needs (see lib/fbar.ts's doc comment
// for why this specific rate, not the IRS's year-average rate). Exists because this is called from
// the browser (components/reports/FbarReport.tsx) and a government API supporting browser CORS
// isn't something this app controls or can assume -- routing it through the Worker sidesteps that
// entirely, same reason PlaidImport/SchwabImport/etc. all proxy their own third-party APIs here
// rather than calling them directly from client JS.
//
// Only ever a FALLBACK for a year not yet in lib/fbar.ts's own hardcoded TREASURY_YEAR_END_RATE_INR
// table -- once Treasury actually publishes a new year's rate (confirmed quarterly, with the Dec 31
// figure typically appearing a few weeks into the following January), this picks it up automatically
// instead of the app needing a manual code update and redeploy every single year just to add one
// number. The hardcoded table stays authoritative for every year already in it -- this route is
// never consulted for those, so a change here can't retroactively alter a figure already reviewed
// and locked in.
//
// No access-token gate (same posture as /api/sync-status): this proxies public government data,
// returns nothing about the user's own vault, and the edge cache below both protects Treasury's API
// from being hammered and limits how often this Worker itself does the outbound fetch.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const year = url.searchParams.get("year") || "";
  const country = url.searchParams.get("country") || "India";
  if (!/^\d{4}$/.test(year)) {
    return Response.json({ error: "year must be a 4-digit calendar year" }, { status: 400 });
  }

  // A full year never changes once published, so this is safe to cache for a long time -- the
  // only reason to ever re-fetch is a year that's NOT published yet, which this app only asks
  // about once per session per year at most (see FbarReport.tsx's own fetch-once guard).
  return withEdgeCache(request, 24 * 60 * 60, async () => {
    const filter = `country:eq:${country},record_calendar_year:eq:${year},record_calendar_month:eq:12,record_calendar_day:eq:31`;
    const treasuryUrl =
      `https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/od/rates_of_exchange` +
      `?filter=${encodeURIComponent(filter)}&sort=-record_date&page[size]=1`;
    let data: { exchange_rate?: string; record_date?: string }[] = [];
    try {
      const r = await fetch(treasuryUrl);
      // A non-2xx response here is passed straight through BY withEdgeCache without being
      // cached (it only caches on response.ok) -- deliberate, so "not published yet" never
      // gets locked in at the edge for a full day and masks the real rate appearing later.
      if (!r.ok) return new Response(null, { status: 502 });
      const json = (await r.json()) as { data?: typeof data };
      data = json.data ?? [];
    } catch {
      return new Response(null, { status: 502 });
    }
    const row = data[0];
    const rate = row?.exchange_rate ? Number(row.exchange_rate) : null;
    if (!row || rate === null || !Number.isFinite(rate)) {
      return new Response(null, { status: 404 }); // not published yet -- see the !r.ok comment above
    }
    return Response.json({
      rate,
      asOf: row.record_date,
      source: "US Treasury Bureau of the Fiscal Service, Reporting Rates of Exchange (api.fiscaldata.treasury.gov), fetched live",
    });
  });
}

export interface WatchlistEntry {
  symbol: string;
  company: string;
  horizon: "short" | "long" | "cyclical";
  thesis: string;
  analystTarget?: number;
  buyBelow?: number;
  sellAbove?: number;
  buyMonths?: number[];
  sellMonths?: number[];
  seasonNote?: string;
}

export const WATCHLIST_DEFAULT: WatchlistEntry[] = [
  // Short-term momentum (Aug 2026)
  { symbol: "AMD",  company: "Advanced Micro Devices", horizon: "short", thesis: "AI GPU chips for data centers — NVDA's main competition. Stock tripled in 2026; 51-analyst consensus target $600 (Strong Buy). Data center MI300X momentum continues.", analystTarget: 600, buyBelow: 440, sellAbove: 580 },
  { symbol: "AVGO", company: "Broadcom", horizon: "short", thesis: "AI networking chip leader. July selloff reset valuation — 48 analyst Strong Buy consensus. Strong data center demand continues into H2.", analystTarget: 528, buyBelow: 400, sellAbove: 505 },
  { symbol: "MU",   company: "Micron Technology", horizon: "short", thesis: "HBM memory chips for AI data centers. Up 70% in 2026 already — supply tightening into Q4. Analyst consensus raised sharply to $1,502.", analystTarget: 1502, buyBelow: 820, sellAbove: 1200 },
  { symbol: "GLW",  company: "Corning", horizon: "short", thesis: "Top Aug 2026 momentum pick. Optical fiber demand surging from AI data center builds. BofA and Susquehanna both raised targets. Analyst avg $200.", analystTarget: 200, buyBelow: 148, sellAbove: 195 },
  { symbol: "XPO",  company: "XPO Inc", horizon: "short", thesis: "Logistics/industrial momentum. US reshoring and manufacturing capex beneficiary. 32 analyst Buy consensus, +17% upside to $233 target.", analystTarget: 233, buyBelow: 190, sellAbove: 225 },
  { symbol: "INTU", company: "Intuit", horizon: "short", thesis: "AI-powered tax + accounting products. 35 analyst Buy consensus, +36% upside to $456 target. Seasonal kicker Oct–Apr (tax season).", analystTarget: 456, buyBelow: 315, sellAbove: 440 },
  // Long-term structural holds
  { symbol: "MSFT", company: "Microsoft", horizon: "long", thesis: "Azure AI platform growing 40%+ YoY. Copilot embedded across enterprise. Most defensive AI play — cash flows protect downside. Analyst avg $559.", analystTarget: 559, buyBelow: 470, sellAbove: 545 },
  { symbol: "ANET", company: "Arista Networks", horizon: "long", thesis: "Ethernet switching for AI data centers. Strong moat, recurring revenue. BofA raised to $305, S&P Global avg $242 — Strong Buy, 30 analysts.", analystTarget: 242, buyBelow: 180, sellAbove: 235 },
  { symbol: "SOFI", company: "SoFi Technologies", horizon: "long", thesis: "Fintech bank — consensus Hold (not Buy) as of Aug 2026. Rate cuts help loan origination. Speculative position, size small.", analystTarget: 22, buyBelow: 14, sellAbove: 21 },
  { symbol: "COF",  company: "Capital One Financial", horizon: "long", thesis: "Discover merger approved and integrating. Analyst avg target $261, +39% upside from current $188. Multiple analyst upgrades post-merger clarity.", analystTarget: 261, buyBelow: 185, sellAbove: 250 },
  { symbol: "CRDO", company: "Credo Technology", horizon: "long", thesis: "High-speed AEC connectivity chips for hyperscalers. 14 analyst consensus target $272 — strong upside if AI capex holds. High risk.", analystTarget: 272, buyBelow: 235, sellAbove: 265 },
  // Cyclicals with seasonal windows
  { symbol: "DKNG", company: "DraftKings", horizon: "cyclical", thesis: "NFL season starts Sep. Stock surged 8% on Aug 7 Q2 results on prediction-market growth. Currently at $25 — well below analyst $32 target.", buyMonths: [8,9], sellMonths: [1,2], seasonNote: "NFL season", analystTarget: 32, buyBelow: 27, sellAbove: 38 },
  { symbol: "DAL",  company: "Delta Air Lines", horizon: "cyclical", thesis: "Summer travel peak = sell window NOW (Aug at $90). Re-enter Mar–Apr at dips ahead of next summer booking surge. Analyst target $103.", buyMonths: [3,4], sellMonths: [7,8], seasonNote: "Summer travel", analystTarget: 103, buyBelow: 82, sellAbove: 100 },
  { symbol: "BKNG", company: "Booking Holdings", horizon: "cyclical", thesis: "25-for-1 stock split completed Apr 2026 — now trades ~$213. Travel platform. Winter lull (Jan–Feb) best entry. Sell into June summer peak.", buyMonths: [1,2], sellMonths: [6,7], seasonNote: "Travel booking cycle", analystTarget: 236, buyBelow: 195, sellAbove: 235 },
  { symbol: "HD",   company: "Home Depot", horizon: "cyclical", thesis: "Spring renovation rush. Buy Feb–Mar before DIY season, sell by June. Analyst avg target $374.", buyMonths: [2,3], sellMonths: [6,7], seasonNote: "Spring renovation", analystTarget: 374, buyBelow: 355, sellAbove: 415 },
  { symbol: "DE",   company: "John Deere", horizon: "cyclical", thesis: "Farm equipment orders front-run planting. Buy Nov–Dec as farmers plan, sell Mar–Apr at planting peak. Analyst avg $648 — stock near target.", buyMonths: [11,12], sellMonths: [3,4], seasonNote: "Planting season", analystTarget: 648, buyBelow: 615, sellAbove: 700 },
  { symbol: "HRB",  company: "H&R Block", horizon: "cyclical", thesis: "Rock-solid tax season pattern. Buy Oct–Nov, sell by April 15. Hold consensus from analysts (avg $39), Goldman has Sell at $32 — size small.", buyMonths: [10,11], sellMonths: [3,4], seasonNote: "Tax season", analystTarget: 39, buyBelow: 34, sellAbove: 45 },
  { symbol: "TSLA", company: "Tesla", horizon: "cyclical", thesis: "Q4 delivery push drives stock up each year. Buy Oct dip, sell Jan after delivery numbers. Analyst consensus $423 as of Aug 2026.", buyMonths: [10,11], sellMonths: [1], seasonNote: "Q4 delivery push", analystTarget: 423, buyBelow: 380, sellAbove: 480 },
  { symbol: "COST", company: "Costco", horizon: "cyclical", thesis: "Holiday bulk buying + membership renewals drive Q4. Buy Sep before the run, sell Dec. Analyst avg $1,077 — near all-time highs.", buyMonths: [9], sellMonths: [12], seasonNote: "Holiday season", analystTarget: 1077, buyBelow: 980, sellAbove: 1100 },
  { symbol: "MGM",  company: "MGM Resorts", horizon: "cyclical", thesis: "Holiday season + New Year Vegas bookings drive Q4. Stock at $46. Buy Oct dip, sell after New Year peak.", buyMonths: [10,11], sellMonths: [1], seasonNote: "Holiday & New Year gaming", buyBelow: 42, sellAbove: 54 },
];

const stats = [
  { label: "Historical vouchers", value: "9,205", note: "Apr 2016 – Jul 2026" },
  { label: "Tally ledgers", value: "209", note: "Ready to classify" },
  { label: "Payments", value: "7,291", note: "79.2% of activity" },
  { label: "Receipts", value: "1,240", note: "13.5% of activity" },
];
const recent = [
  ["Payment", "Bank account", "Jul 9, 2026", "−$1,284.00"],
  ["Transfer", "Investment account", "Jul 8, 2026", "−$2,500.00"],
  ["Receipt", "Bank account", "Jul 7, 2026", "+$4,850.00"],
  ["Payment", "Credit card", "Jul 5, 2026", "−$216.48"],
];
export default function Home() {
 return <main className="shell">
  <aside><div className="brand"><b>P</b><span>Personal Ledger<small>US Books</small></span></div><nav><a className="on">Overview</a><a>Transactions <i>9,205</i></a><a>Accounts <i>209</i></a><a>Investments</a><a>Reports</a><a>Tally Migration</a></nav><div className="source"><em/> <span>Migration source ready<small>Validated Jul 10, 2026</small></span></div><div className="user"><b>DK</b><span>Dignesh Khatri<small>Personal workspace</small></span></div></aside>
  <section className="workspace"><header><div><small>PERSONAL FINANCE</small><h1>Good morning, Dignesh</h1><p>Your books are current through July 9, 2026.</p></div><div><button>Import statement</button><button className="primary">+ New transaction</button></div></header>
   <section className="hero"><article className="net"><div className="title"><span>Estimated net worth<h2>$614,382</h2></span><button>USD⌄</button></div><label>↑ 4.8% <span>over the last 12 months</span></label><svg viewBox="0 0 700 150"><defs><linearGradient id="g" x1="0" x2="0" y1="0" y2="1"><stop stopColor="#2f6fed" stopOpacity=".25"/><stop offset="1" stopColor="#2f6fed" stopOpacity="0"/></linearGradient></defs><path d="M0 125C70 115 85 118 130 105S200 112 245 88 320 95 365 73 435 79 478 56 550 67 595 40 657 36 700 18V150H0Z" fill="url(#g)"/><path d="M0 125C70 115 85 118 130 105S200 112 245 88 320 95 365 73 435 79 478 56 550 67 595 40 657 36 700 18" fill="none" stroke="#2f6fed" strokeWidth="3"/></svg><div className="months"><span>Aug</span><span>Oct</span><span>Dec</span><span>Feb</span><span>Apr</span><span>Jun</span></div></article>
   <article className="migration"><div className="check">✓</div><div><small>TALLY ERP 9</small><h3>US history is ready</h3><p>All 9,205 vouchers passed structural validation.</p></div><dl><div><dt>Period</dt><dd>Apr 2016 – Jul 2026</dd></div><div><dt>Currencies</dt><dd>2</dd></div><div><dt>Status</dt><dd className="good">Ready</dd></div></dl><button>Review migration →</button></article></section>
   <section className="stats">{stats.map(s=><article key={s.label}><span>{s.label}</span><strong>{s.value}</strong><small>{s.note}</small></article>)}</section>
   <section className="lower"><article className="panel"><div className="panelhead"><span><h3>Recent activity</h3><p>Preview of your transaction workspace</p></span><a>View all →</a></div>{recent.map((r,i)=><div className="row" key={i}><b className={r[0].toLowerCase()}>{r[0]==="Receipt"?"↓":"↑"}</b><span><strong>{r[0]}</strong><small>{r[1]}</small></span><span className="amount"><strong className={r[3].startsWith("+")?"positive":""}>{r[3]}</strong><small>{r[2]}</small></span></div>)}</article>
   <article className="panel"><div className="panelhead"><span><h3>Migration composition</h3><p>Voucher distribution</p></span></div><div className="donut"><div><strong>9,205</strong><small>Total</small></div></div><ul><li><i className="p"/>Payments <b>79.2%</b></li><li><i className="r"/>Receipts <b>13.5%</b></li><li><i className="c"/>Contra <b>7.1%</b></li><li><i className="j"/>Journal <b>0.2%</b></li></ul></article></section>
   <p className="note">The displayed financial amounts are illustrative until Tally reconciliation is complete.</p>
  </section>
 </main>
}
const fs = require("fs");
const path = require("path");

const root = process.cwd();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

function backup(file) {
  fs.copyFileSync(file, `${file}.backup-ledger-view-${stamp}`);
}

const txPath = path.join(root, "components", "TransactionTable.tsx");
const appPath = path.join(root, "components", "VaultApp.tsx");
const cssPath = path.join(root, "app", "globals.css");

backup(txPath);
backup(appPath);
backup(cssPath);

let tx = fs.readFileSync(txPath, "utf8");

if (!tx.includes("ledgerSignedAmount")) {
  tx = tx.replace(
    /const amount=\(t:VoucherRow\)=>t\.entries\.reduce\(\(sum,e\)=>sum\+Math\.abs\(e\.amount\),0\)\/2;/,
    `$&
const normLedger=(value:unknown)=>text(String(value??"")).trim().toLowerCase();
const ledgerSignedAmount=(t:VoucherRow,selectedLedgerName?:string)=>{
  const wanted=normLedger(selectedLedgerName);
  if(wanted){
    const signed=t.entries.filter(e=>normLedger(e.accountName)===wanted).reduce((sum,e)=>sum+Number(e.amount||0),0);
    if(Math.abs(signed)>0.004)return signed>0?-Math.abs(signed):Math.abs(signed);
  }
  return amount(t);
};`
  );
}

tx = tx.replace(
  /export function TransactionTable\(\{transactions,formatAmount,onView,onEdit,onCopy,onDelete\}:\{transactions:VoucherRow\[\];formatAmount:\(n:number\)=>string;onView:\(t:VoucherRow\)=>void;onEdit:\(t:VoucherRow\)=>void;onCopy:\(t:VoucherRow\)=>void;onDelete:\(t:VoucherRow\)=>void\}\)\{/,
  `export function TransactionTable({transactions,formatAmount,onView,onEdit,onCopy,onDelete,selectedLedgerName}:{transactions:VoucherRow[];formatAmount:(n:number)=>string;onView:(t:VoucherRow)=>void;onEdit:(t:VoucherRow)=>void;onCopy:(t:VoucherRow)=>void;onDelete:(t:VoucherRow)=>void;selectedLedgerName?:string}){`
);

tx = tx.replace(/key==="amount"\?amount\(t\)/g, `key==="amount"?ledgerSignedAmount(t,selectedLedgerName)`);
tx = tx.replace(/\{formatAmount\(amount\(t\)\)\}/g, `{formatAmount(ledgerSignedAmount(t,selectedLedgerName))}`);
tx = tx.replace(/rows\.reduce\(\(sum,t\)=>sum\+amount\(t\),0\),\[rows\]/g, `rows.reduce((sum,t)=>sum+ledgerSignedAmount(t,selectedLedgerName),0),[rows,selectedLedgerName]`);
tx = tx.replace(/\}\),\[transactions,filters,sort\]\);/g, `}),[transactions,filters,sort,selectedLedgerName]);`);

fs.writeFileSync(txPath, tx, "utf8");

let app = fs.readFileSync(appPath, "utf8");

app = app.replace(
  /<div className="drill-panel" onClick=\{e=>e\.stopPropagation\(\)\}><button className="drill-close"\s+onClick=\{\(\)=>setSelected\(null\)\}>Close<\/button><h2>\{selectedRow\.name\}/,
  `<div className="drill-panel ledger-drill-panel" onClick={e=>e.stopPropagation()}><button className="drill-close" onClick={()=>setSelected(null)}>Close</button><h2>{selectedRow.name}`
);

app = app.replace(
  /<TransactionTable transactions=\{selectedTx\} formatAmount=\{fmt\}/,
  `<TransactionTable transactions={selectedTx} selectedLedgerName={selectedRow.name} formatAmount={fmt}`
);

fs.writeFileSync(appPath, app, "utf8");

let css = fs.readFileSync(cssPath, "utf8");

if (!css.includes("Ledger drilldown wide view")) {
  css += `
/* Ledger drilldown wide view */
.drill-panel.ledger-drill-panel{width:min(1600px,calc(100vw - 36px))!important;max-width:none!important}
.drill-panel.ledger-drill-panel .top-scroll{display:none!important}
.drill-panel.ledger-drill-panel .table-scroll{overflow-x:visible!important;max-width:100%!important}
.drill-panel.ledger-drill-panel .transaction-table{width:100%!important;min-width:0!important;table-layout:fixed!important}
.drill-panel.ledger-drill-panel .transaction-table th,
.drill-panel.ledger-drill-panel .transaction-table td{white-space:normal!important;overflow:visible!important;text-overflow:clip!important;overflow-wrap:anywhere!important;line-height:1.35!important}
.drill-panel.ledger-drill-panel .transaction-table th:nth-child(1){width:92px!important}
.drill-panel.ledger-drill-panel .transaction-table th:nth-child(2){width:105px!important}
.drill-panel.ledger-drill-panel .transaction-table th:nth-child(3){width:82px!important}
.drill-panel.ledger-drill-panel .transaction-table th:nth-child(4),
.drill-panel.ledger-drill-panel .transaction-table th:nth-child(5){width:18%!important}
.drill-panel.ledger-drill-panel .transaction-table th:nth-child(7){width:110px!important}
.drill-panel.ledger-drill-panel .transaction-table th:nth-child(8){width:58px!important}
.drill-panel.ledger-drill-panel .transaction-table .date-cell,
.drill-panel.ledger-drill-panel .transaction-table td.right{white-space:nowrap!important}
`;
}

fs.writeFileSync(cssPath, css, "utf8");

console.log("Ledger view fix applied.");
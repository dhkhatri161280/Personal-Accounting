const fs = require("fs");
const path = require("path");

const root = process.cwd();
const txPath = path.join(root, "components", "TransactionTable.tsx");
const appPath = path.join(root, "components", "VaultApp.tsx");
const cssPath = path.join(root, "app", "globals.css");

function backup(file) {
  if (fs.existsSync(file)) {
    fs.copyFileSync(file, `${file}.backup-ledger-wide-signed-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  }
}

function mustReplace(s, from, to, label) {
  if (!s.includes(from)) throw new Error(`Could not find ${label}`);
  return s.replace(from, to);
}

backup(txPath);
let tx = fs.readFileSync(txPath, "utf8");

if (!tx.includes("selectedLedgerName?:string")) {
  tx = mustReplace(
    tx,
    `const amount=(t:VoucherRow)=>t.entries.reduce((sum,e)=>sum+Math.abs(e.amount),0)/2;`,
    `const amount=(t:VoucherRow)=>t.entries.reduce((sum,e)=>sum+Math.abs(e.amount),0)/2;
const normLedger=(value:unknown)=>text(String(value??"")).trim().toLowerCase();
const ledgerSignedAmount=(t:VoucherRow,selectedLedgerName?:string)=>{
  const wanted=normLedger(selectedLedgerName);
  if(wanted){
    const signed=t.entries.filter(e=>normLedger(e.accountName)===wanted).reduce((sum,e)=>sum+Number(e.amount||0),0);
    if(Math.abs(signed)>0.004)return signed>0?-Math.abs(signed):Math.abs(signed);
  }
  return amount(t);
};`,
    "amount helper"
  );

  tx = mustReplace(
    tx,
    `export function TransactionTable({transactions,formatAmount,onView,onEdit,onCopy,onDelete}:{transactions:VoucherRow[];formatAmount:(n:number)=>string;onView:(t:VoucherRow)=>void;onEdit:(t:VoucherRow)=>void;onCopy:(t:VoucherRow)=>void;onDelete:(t:VoucherRow)=>void}){`,
    `export function TransactionTable({transactions,formatAmount,onView,onEdit,onCopy,onDelete,selectedLedgerName}:{transactions:VoucherRow[];formatAmount:(n:number)=>string;onView:(t:VoucherRow)=>void;onEdit:(t:VoucherRow)=>void;onCopy:(t:VoucherRow)=>void;onDelete:(t:VoucherRow)=>void;selectedLedgerName?:string}){`,
    "TransactionTable props"
  );

  tx = mustReplace(tx, `key==="amount"?amount(t)`, `key==="amount"?ledgerSignedAmount(t,selectedLedgerName)`, "amount value");
  tx = mustReplace(tx, `}),[transactions,filters,sort]);`, `}),[transactions,filters,sort,selectedLedgerName]);`, "memo deps");
  tx = mustReplace(tx, `rows.reduce((sum,t)=>sum+amount(t),0),[rows]`, `rows.reduce((sum,t)=>sum+ledgerSignedAmount(t,selectedLedgerName),0),[rows,selectedLedgerName]`, "total");
  tx = mustReplace(tx, `{formatAmount(amount(t))}`, `{formatAmount(ledgerSignedAmount(t,selectedLedgerName))}`, "row amount");

  fs.writeFileSync(txPath, tx, "utf8");
  console.log("PATCHED TransactionTable.tsx");
}

backup(appPath);
let app = fs.readFileSync(appPath, "utf8");

if (!app.includes("ledger-drill-panel")) {
  app = mustReplace(
    app,
    `<div className="drill-panel" onClick={e=>e.stopPropagation()}><button className="drill-close" onClick={()=>setSelected(null)}>Close</button><h2>{selectedRow.name}</h2>`,
    `<div className="drill-panel ledger-drill-panel" onClick={e=>e.stopPropagation()}><button className="drill-close" onClick={()=>setSelected(null)}>Close</button><h2>{selectedRow.name}</h2>`,
    "ledger drill panel"
  );
}

if (!app.includes("selectedLedgerName={selectedRow.name}")) {
  app = mustReplace(
    app,
    `<TransactionTable transactions={selectedTx} formatAmount={fmt}`,
    `<TransactionTable transactions={selectedTx} selectedLedgerName={selectedRow.name} formatAmount={fmt}`,
    "selected ledger table prop"
  );
}

fs.writeFileSync(appPath, app, "utf8");
console.log("PATCHED VaultApp.tsx");

backup(cssPath);
let css = fs.readFileSync(cssPath, "utf8");

if (!css.includes("Ledger drilldown wide view")) {
  css += `

/* Ledger drilldown wide view and selected-ledger signed amounts. */
.drill-panel.ledger-drill-panel{width:min(1500px,calc(100vw - 48px));max-width:none}
.drill-panel.ledger-drill-panel .transaction-table{width:100%;min-width:0;table-layout:fixed}
.drill-panel.ledger-drill-panel .transaction-table th,
.drill-panel.ledger-drill-panel .transaction-table td{white-space:normal;overflow:visible;text-overflow:clip;overflow-wrap:anywhere;line-height:1.35}
.drill-panel.ledger-drill-panel .transaction-table th:nth-child(1){width:92px}
.drill-panel.ledger-drill-panel .transaction-table th:nth-child(2){width:110px}
.drill-panel.ledger-drill-panel .transaction-table th:nth-child(3){width:86px}
.drill-panel.ledger-drill-panel .transaction-table th:nth-child(4),
.drill-panel.ledger-drill-panel .transaction-table th:nth-child(5){width:18%}
.drill-panel.ledger-drill-panel .transaction-table th:nth-child(7){width:115px}
.drill-panel.ledger-drill-panel .transaction-table th:nth-child(8){width:58px}
.drill-panel.ledger-drill-panel .transaction-table .date-cell,
.drill-panel.ledger-drill-panel .transaction-table td.right{white-space:nowrap}
@media(max-width:700px){.drill-panel.ledger-drill-panel{width:100vw}.drill-panel.ledger-drill-panel .transaction-table{min-width:980px}}
`;
  fs.writeFileSync(cssPath, css, "utf8");
  console.log("PATCHED globals.css");
}

console.log("Ledger drilldown patch complete.");
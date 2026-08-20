const fs = require("fs");
const path = require("path");

const appPath = path.join(process.cwd(), "components", "VaultApp.tsx");
const cssPath = path.join(process.cwd(), "app", "globals.css");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

let app = fs.readFileSync(appPath, "utf8");
let css = fs.readFileSync(cssPath, "utf8");

fs.copyFileSync(appPath, `${appPath}.backup-period-selector-${stamp}`);
fs.copyFileSync(cssPath, `${cssPath}.backup-period-selector-${stamp}`);

if (!app.includes("drill-period-control")) {
  const financialIndex = app.indexOf("Financial period");
  if (financialIndex < 0) throw new Error("Could not find Financial period selector text.");

  const selectStart = app.indexOf("<select", financialIndex);
  if (selectStart < 0) throw new Error("Could not find Financial period <select>.");

  const selectEnd = app.indexOf("</select>", selectStart);
  if (selectEnd < 0) throw new Error("Could not find Financial period </select>.");

  const selectMarkup = app.slice(selectStart, selectEnd + "</select>".length);

  const periodControl =
    `<div className="drill-period-control"><span>Financial period</span>${selectMarkup}</div>`;

  app = app.replace(
    `<h2>{selectedRow.name}</h2><p>{selectedRow.parent||selectedRow.category} | {periodLabel}</p><section className="drill-summary">`,
    `<h2>{selectedRow.name}</h2><p>{selectedRow.parent||selectedRow.category}</p>${periodControl}<section className="drill-summary">`
  );

  app = app.replace(
    `<h2>{cashFlowDetail}</h2><p>Cash Flow | {periodLabel}</p><TransactionTable`,
    `<h2>{cashFlowDetail}</h2><p>Cash Flow</p>${periodControl}<TransactionTable`
  );

  fs.writeFileSync(appPath, app, "utf8");
  console.log("Added period selector to ledger/report drilldown screens.");
} else {
  console.log("Period selector already exists in drilldown screens.");
}

if (!css.includes("drill-period-control")) {
  css += `
.drill-period-control{display:flex;align-items:center;gap:14px;margin:14px 0 18px}
.drill-period-control span{font-size:13px;font-weight:800;color:#001b44}
.drill-period-control select{min-width:300px;height:46px;border:1px solid #cbd8ea;border-radius:8px;background:#f8fbff;color:#001b44;font-size:18px;padding:0 14px}
@media(max-width:900px){
  .drill-period-control{align-items:flex-start;flex-direction:column;gap:8px}
  .drill-period-control select{width:100%;min-width:0;font-size:16px}
}
`;
  fs.writeFileSync(cssPath, css, "utf8");
  console.log("Added period selector CSS.");
} else {
  console.log("Period selector CSS already exists.");
}
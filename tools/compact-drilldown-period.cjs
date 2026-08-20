const fs = require("fs");
const path = require("path");

const appPath = path.join(process.cwd(), "components", "VaultApp.tsx");
const cssPath = path.join(process.cwd(), "app", "globals.css");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

let app = fs.readFileSync(appPath, "utf8");
let css = fs.readFileSync(cssPath, "utf8");

fs.copyFileSync(appPath, `${appPath}.backup-compact-period-${stamp}`);
fs.copyFileSync(cssPath, `${cssPath}.backup-compact-period-${stamp}`);

app = app.replace(
  /<h2>\{selectedRow\.name\}<\/h2><p>\{selectedRow\.parent\|\|selectedRow\.category\}<\/p><div className="drill-period-control"><span>Financial period<\/span>(<select[\s\S]*?<\/select>)<\/div>/,
  `<div className="drill-title-row"><div><h2>{selectedRow.name}</h2><p>{selectedRow.parent||selectedRow.category}</p></div><div className="drill-period-control compact"><span>Period</span>$1</div></div>`
);

app = app.replace(
  /<h2>\{cashFlowDetail\}<\/h2><p>Cash Flow<\/p><div className="drill-period-control"><span>Financial period<\/span>(<select[\s\S]*?<\/select>)<\/div>/,
  `<div className="drill-title-row"><div><h2>{cashFlowDetail}</h2><p>Cash Flow</p></div><div className="drill-period-control compact"><span>Period</span>$1</div></div>`
);

fs.writeFileSync(appPath, app, "utf8");

css = css.replace(/\.drill-period-control\{[^}]*\}/g, "");
css = css.replace(/\.drill-period-control span\{[^}]*\}/g, "");
css = css.replace(/\.drill-period-control select\{[^}]*\}/g, "");
css = css.replace(/@media\(max-width:900px\)\{\s*\.drill-period-control\{[^}]*\}\s*\.drill-period-control select\{[^}]*\}\s*\}/g, "");

if (!css.includes("drill-title-row")) {
  css += `
.drill-title-row{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;margin-bottom:18px;padding-right:92px}
.drill-title-row h2{margin:0 0 6px}
.drill-title-row p{margin:0;color:#42577c}
.drill-period-control.compact{display:flex;align-items:center;gap:8px;margin:0}
.drill-period-control.compact span{font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#63789c}
.drill-period-control.compact select{height:34px;min-width:210px;border:1px solid #cbd8ea;border-radius:8px;background:#f8fbff;color:#001b44;font-size:13px;font-weight:700;padding:0 32px 0 10px}
@media(max-width:900px){
  .drill-title-row{display:block;padding-right:0}
  .drill-period-control.compact{margin-top:10px}
  .drill-period-control.compact select{width:100%;min-width:0}
}
`;
}

fs.writeFileSync(cssPath, css, "utf8");
console.log("Compact drilldown period selector applied.");
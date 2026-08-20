const fs = require("fs");
const path = require("path");

const cssPath = path.join(process.cwd(), "app", "globals.css");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

let css = fs.readFileSync(cssPath, "utf8");
fs.copyFileSync(cssPath, `${cssPath}.backup-phone-safe-ledger-${stamp}`);

const marker = "/* Ledger drilldown wide view */";
const markerIndex = css.indexOf(marker);

if (markerIndex >= 0) {
  css = css.slice(0, markerIndex).trimEnd() + "\n";
}

css += `
/* Ledger drilldown wide view - desktop only */
@media (min-width: 901px) {
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
}
`;

fs.writeFileSync(cssPath, css, "utf8");
console.log("Phone-safe ledger CSS applied. Desktop gets wide view; phone keeps original layout.");
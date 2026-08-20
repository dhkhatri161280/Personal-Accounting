const fs = require("fs");
const path = require("path");

const cssPath = path.join(process.cwd(), "app", "globals.css");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

let css = fs.readFileSync(cssPath, "utf8");
fs.copyFileSync(cssPath, `${cssPath}.backup-hide-install-detail-${stamp}`);

const marker = "/* Hide install app CTA on detail screens */";
const existing = css.indexOf(marker);

if (existing >= 0) {
  css = css.slice(0, existing).trimEnd() + "\n";
}

css += `
/* Hide install app CTA on detail screens */
.drill-overlay{z-index:2147483000!important}
.drill-panel{position:relative;z-index:2147483001!important}

@media(max-width:900px){
  body:has(.drill-overlay) .install-button,
  body:has(.drill-overlay) .install-app,
  body:has(.drill-overlay) .app-install,
  body:has(.drill-overlay) .pwa-install,
  body:has(.drill-overlay) .store-button,
  body:has(.drill-overlay) .store-link,
  body:has(.drill-overlay) .download-app,
  body:has(.drill-overlay) button:has(img[src*="play"]),
  body:has(.drill-overlay) a:has(img[src*="play"]),
  body:has(.drill-overlay) button:has(img[src*="app-store"]),
  body:has(.drill-overlay) a:has(img[src*="app-store"]){
    display:none!important;
    opacity:0!important;
    pointer-events:none!important;
  }
}
`;

fs.writeFileSync(cssPath, css, "utf8");
console.log("Install app button hidden on detail screens. Home screen remains unchanged.");
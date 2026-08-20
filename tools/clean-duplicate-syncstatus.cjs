const fs = require("fs");
const path = require("path");

const file = path.join(process.cwd(), "components", "VaultApp.tsx");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

let source = fs.readFileSync(file, "utf8");
fs.copyFileSync(file, `${file}.backup-clean-syncstatus-${stamp}`);

function scanBraces(src) {
  const spans = [];
  const stack = [];
  let quote = null;
  let esc = false;

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];

    if (quote) {
      if (esc) {
        esc = false;
        continue;
      }
      if (c === "\\") {
        esc = true;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }

    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      continue;
    }

    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }

    if (c === "/" && n === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i++;
      continue;
    }

    if (c === "{") stack.push(i);
    if (c === "}") {
      const start = stack.pop();
      if (start !== undefined) spans.push([start, i]);
    }
  }

  return spans;
}

function findPropEnd(src, start, limit) {
  let quote = null;
  let esc = false;
  let depth = 0;

  for (let i = start; i < limit; i++) {
    const c = src[i];
    const n = src[i + 1];

    if (quote) {
      if (esc) {
        esc = false;
        continue;
      }
      if (c === "\\") {
        esc = true;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }

    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      continue;
    }

    if (c === "/" && n === "/") {
      while (i < limit && src[i] !== "\n") i++;
      continue;
    }

    if (c === "/" && n === "*") {
      i += 2;
      while (i < limit && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i++;
      continue;
    }

    if (c === "{" || c === "(" || c === "[") depth++;
    else if (c === "}" || c === ")" || c === "]") depth--;
    else if (c === "," && depth === 0) return { end: i + 1, hasComma: true };
  }

  return { end: limit, hasComma: false };
}

function findPrevComma(src, start, limitStart) {
  let quote = null;
  let esc = false;
  let depth = 0;

  for (let i = start - 1; i > limitStart; i--) {
    const c = src[i];

    if (quote) {
      if (esc) {
        esc = false;
        continue;
      }
      if (c === "\\") {
        esc = true;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }

    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      continue;
    }

    if (c === "}" || c === ")" || c === "]") depth++;
    else if (c === "{" || c === "(" || c === "[") depth--;
    else if (c === "," && depth === 0) return i;
  }

  return -1;
}

function topLevelSyncStatusProps(src, start, end) {
  const props = [];
  let quote = null;
  let esc = false;
  let depth = 0;

  for (let i = start + 1; i < end; i++) {
    const c = src[i];
    const n = src[i + 1];

    if (quote) {
      if (esc) {
        esc = false;
        continue;
      }
      if (c === "\\") {
        esc = true;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }

    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      continue;
    }

    if (c === "/" && n === "/") {
      while (i < end && src[i] !== "\n") i++;
      continue;
    }

    if (c === "/" && n === "*") {
      i += 2;
      while (i < end && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i++;
      continue;
    }

    if (c === "{" || c === "(" || c === "[") depth++;
    else if (c === "}" || c === ")" || c === "]") depth--;
    else if (depth === 0 && src.slice(i).match(/^syncStatus\s*:/)) {
      const propEnd = findPropEnd(src, i, end);
      let removeStart = i;
      let removeEnd = propEnd.end;

      if (!propEnd.hasComma) {
        const prevComma = findPrevComma(src, i, start);
        if (prevComma >= 0) removeStart = prevComma;
      }

      props.push({ start: i, removeStart, removeEnd });
    }
  }

  return props;
}

const removals = [];

for (const [start, end] of scanBraces(source)) {
  const props = topLevelSyncStatusProps(source, start, end);
  if (props.length > 1) {
    for (const duplicate of props.slice(1)) {
      removals.push([duplicate.removeStart, duplicate.removeEnd]);
    }
  }
}

if (removals.length === 0) {
  console.log("No duplicate syncStatus property found in VaultApp.tsx.");
  process.exit(0);
}

removals.sort((a, b) => b[0] - a[0]);

for (const [start, end] of removals) {
  source = source.slice(0, start) + source.slice(end);
}

fs.writeFileSync(file, source, "utf8");
console.log(`Removed ${removals.length} duplicate syncStatus property/properties from VaultApp.tsx.`);
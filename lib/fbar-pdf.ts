import type { Ledger, Account } from "./vault-types.ts";
import type { FbarAccountRow } from "./fbar.ts";

// Pre-fills FinCEN Form 114 (FBAR) -- a dynamic Adobe XFA form (not a plain fillable PDF), which
// is why this can't use pdf-lib's normal form-field API (getForm/getFields, which only
// understands AcroForm field widgets). An XFA form instead stores its answers as an XML "data"
// packet embedded in the PDF's /AcroForm /XFA array; Adobe Reader re-renders the whole form from
// that XML plus the form's own /XFA "template" packet every time the PDF is opened. So this
// module builds that XML data packet and swaps it into the blank template PDF shipped at
// public/forms/fincen-fbar-114.pdf, rather than filling named widgets.
//
// Every element name/path and every coded value below (e.g. TypeOfFiler="A" for Individual,
// AccountType="A" for Bank) was reverse-engineered directly from that template PDF's own /XFA
// "template" and "datasets" packets (its field definitions' <items> choice lists, <bind ref="...">
// data paths, and toolTips) -- not guessed or taken from FinCEN's human-readable instructions,
// since a wrong code on this form is a real filing-accuracy risk, not a cosmetic bug.
//
// This still only produces a worksheet-accuracy *draft* -- the user must open the result in Adobe
// Reader (XFA forms don't render in a browser PDF viewer or Preview.app), review every field
// themselves, sign it, and submit it at bsaefiling.fincen.gov. One field in particular,
// Individual's Date of Birth (Item 5), uses an unusual two-field UI pattern in the form's own
// script (a visible MM/DD/YYYY text box that is NOT itself the bound data field, paired with a
// hidden field that the visible one copies into via a FinCEN-authored script this module can't
// introspect) -- this module writes ISO format (YYYY-MM-DD, XFA's own default canonical date
// storage) into the hidden bound field, but can't guarantee Adobe Reader's own script re-displays
// it correctly in the visible box, so Item 5 specifically needs a manual look.

const XFA_NS = "http://www.xfa.org/schema/xfa-data/1.0/";
const FFBAR_NS = "http://www.fincen.gov/bsa/ffbar/2011-06-01";
const UCC_NS = "http://www.fincen.gov/bsa/ucommon-components/2011-06-01";

export type FbarFilerProfile = NonNullable<Ledger["fbarFilerProfile"]>;

export function fbarFilerProfileComplete(p: FbarFilerProfile | undefined): boolean {
  return !!(p?.firstName && p.lastName && p.ssnOrItin && p.dateOfBirth && p.street && p.city && p.state && p.zip);
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function el(tag: string, value: string | number | undefined | null): string {
  if (value === undefined || value === null || value === "") return `<${tag}/>`;
  return `<${tag}>${xmlEscape(String(value))}</${tag}>`;
}

function addressBlock(parentTag: string, address: { street?: string; city?: string; state?: string; zip?: string; country?: string }): string {
  return (
    `<${parentTag}>` +
    `<ucc:Address xmlns:ucc="${UCC_NS}">${address.street ? xmlEscape(address.street) : ""}</ucc:Address>` +
    `<ucc:City xmlns:ucc="${UCC_NS}">${address.city ? xmlEscape(address.city) : ""}</ucc:City>` +
    `<ucc:State xmlns:ucc="${UCC_NS}">${address.state ? xmlEscape(address.state) : ""}</ucc:State>` +
    `<ucc:ZIP xmlns:ucc="${UCC_NS}">${address.zip ? xmlEscape(address.zip) : ""}</ucc:ZIP>` +
    `<ucc:Country xmlns:ucc="${UCC_NS}">${address.country ? xmlEscape(address.country) : ""}</ucc:Country>` +
    `</${parentTag}>`
  );
}

// One <ffbar:FinAcctOwnedSeparately> record per reportable account (Part II of the form). Only
// called with rows already filtered to exclude "exclude"-treatment and not-yet-valued "manual"
// rows -- see buildFbarXfaDatasets.
function accountBlock(row: FbarAccountRow, account: Account | undefined): string {
  // "Bank" nature is a real bank account (checking/savings/FD) -- "A". Everything else this app
  // scopes into FBAR (Investment nature: PPF, LIC Annuity corpus, manually-valued policies, ...)
  // isn't necessarily a brokerage "Securities" account ("B"), so defaults to "Other" ("Z") rather
  // than guessing Securities -- the user should confirm/adjust this one code per account in Adobe
  // Reader, called out explicitly in the UI this function is used from.
  const accountType = row.nature === "Bank" ? "A" : "Z";
  return (
    `<ffbar:FinAcctOwnedSeparately>` +
    el("ffbar:MaximumAccntValue", Math.round(row.maxBalanceUsd)) +
    `<ffbar:MaximumAccntUnkn/>` +
    el("ffbar:AccountType", accountType) +
    `<ffbar:OtherDesc/>` +
    el("ffbar:FinInstName", row.name) +
    el("ffbar:AccntNumber", account?.bankAccountNumber) +
    addressBlock("ffbar:Address", { street: account?.address, country: "India" }) +
    `</ffbar:FinAcctOwnedSeparately>`
  );
}

export function buildFbarXfaDatasets(params: {
  year: number;
  filer: FbarFilerProfile;
  rows: FbarAccountRow[]; // pre-filtered: no "exclude" rows, no unvalued "manual" rows
  accountById: Map<number, Account>;
}): string {
  const { year, filer, rows, accountById } = params;
  const EST_NS = "http://www.fincen.gov/bsa/efile-submission-types/2009-01-01";
  const estEl = (tag: string, value: string | undefined) =>
    value ? `<est:${tag} xmlns:est="${EST_NS}">${xmlEscape(value)}</est:${tag}>` : `<est:${tag} xmlns:est="${EST_NS}"/>`;
  // Item on the form's own Home page, used purely as the filer's own reference label (matches
  // its own placeholder example "SMITH FBAR 2013") -- not a FinCEN-assigned identifier, so a
  // same-shape "LASTNAME FBAR YEAR" is a reasonable default rather than leaving it blank.
  const eFileSubmissionInformation =
    `<ffbar:EFileSubmissionInformation>` +
    estEl("FilingName", filer.lastName ? `${filer.lastName.toUpperCase()} FBAR ${year}` : undefined) +
    estEl("FilingType", undefined) +
    estEl("VersionNumber", undefined) +
    estEl("SubmitUrl", undefined) +
    `</ffbar:EFileSubmissionInformation>`;
  const filerInformation =
    eFileSubmissionInformation +
    `<ffbar:FilerInformation>` +
    el("ffbar:CalendarYear", year) +
    `<ffbar:AmendToPriorReports/>` +
    el("ffbar:TypeOfFiler", "A") + // "A" = Individual, the only filer type this app models
    `<ffbar:FilerOther/>` +
    el("ffbar:TIN", (filer.ssnOrItin || "").replace(/[^0-9]/g, "")) +
    el("ffbar:TINTYPE", "B") + // "B" = SSN/ITIN
    `<ffbar:ForeignId><ffbar:ForeignIdType/><ffbar:OtherIDDesc/><ffbar:IdNumber/><ffbar:IssueCountry/></ffbar:ForeignId>` +
    el("ffbar:DOB", filer.dateOfBirth) + // ISO YYYY-MM-DD -- see module doc comment re: Item 5's own UI quirk
    el("ffbar:LastNameOrNameOfOrg", filer.lastName) +
    el("ffbar:FirstName", filer.firstName) +
    el("ffbar:MiddleName", filer.middleName) +
    el("ffbar:Suffix", filer.suffix) +
    addressBlock("ffbar:Address", filer) +
    el("ffbar:FIInterestIn25OrMore", rows.length >= 25 ? "A" : "B") +
    (rows.length >= 25 ? el("ffbar:totalNumFIAccnts", rows.length) : `<ffbar:totalNumFIAccnts/>`) +
    el("ffbar:SigAuth25OrMore", "B") + // this app only tracks the filer's own financial-interest accounts, never signature-authority-only ones
    `<ffbar:totalNumSigAuthAccnts/>` +
    `<ucc:DocumentControlNumber xmlns:ucc="${UCC_NS}"/>` +
    `<ffbar:FilerSignature/>` +
    `<ffbar:PaidPreparer/>` +
    `<ffbar:LateFilingReason/>` +
    `</ffbar:FilerInformation>`;

  const accounts = rows.map((r) => accountBlock(r, accountById.get(r.accountId))).join("");

  // The actual data root an XFA form reads is xfa:datasets/xfa:data (Adobe's own FormCalc
  // reference: "xfa.datasets" is the data model root, "!data" is shorthand for
  // "xfa.datasets.data") -- NOT the dd:dataDescription sibling that the blank template ships
  // with. That earlier mistake (putting the filled content in dd:dataDescription, copying the
  // blank template's own layout) produced a structurally valid PDF whose data Adobe Reader never
  // actually bound to any field, since a blank xfa:data and populated-but-unbound-dd:dataDescription
  // look identical on an unfilled form -- confirmed live against the real desktop Acrobat app.
  return (
    `<xfa:datasets xmlns:xfa="${XFA_NS}">` +
    `<xfa:data>` +
    `<ffbar:BSAForm xmlns:ffbar="${FFBAR_NS}">` +
    filerInformation +
    accounts +
    `</ffbar:BSAForm>` +
    `</xfa:data>` +
    `</xfa:datasets>`
  );
}

// Swaps the XFA "datasets" packet inside the blank template PDF for the filled XML built above.
// Runs entirely client-side (pdf-lib, dynamically imported, same pattern as lib/trim-pdf.ts) --
// pdf-lib's own high-level form API doesn't understand XFA at all, so this works directly with
// its low-level PDFContext object graph instead: find /AcroForm /XFA's "datasets" stream, decode
// it (it's Flate-compressed), replace its bytes, and write it back uncompressed (simplest to get
// right; the form doesn't care either way). Verified end-to-end against the real FinCEN template
// during development: the round-tripped PDF still opens, and the new data round-trips back out
// byte-identical to what was written in.
export async function fillFbarPdf(xml: string): Promise<Uint8Array> {
  const { PDFDocument, PDFName, PDFDict, PDFArray, PDFStream, PDFRawStream, PDFRef } = await import("pdf-lib");
  const templateBytes = await fetch("/forms/fincen-fbar-114.pdf").then((r) => {
    if (!r.ok) throw new Error(`Could not load the blank FBAR PDF template (${r.status}).`);
    return r.arrayBuffer();
  });
  const doc = await PDFDocument.load(templateBytes, { updateMetadata: false });
  const acroForm = doc.catalog.lookup(PDFName.of("AcroForm"), PDFDict);
  const xfaRef = acroForm.get(PDFName.of("XFA"));
  if (!xfaRef) throw new Error("This PDF template has no XFA packet -- it isn't the expected FinCEN XFA form.");
  const xfa = doc.context.lookup(xfaRef, PDFArray);

  let datasetsRef = null;
  for (let i = 0; i < xfa.size(); i += 2) {
    if (xfa.lookup(i)?.toString() === "(datasets)") {
      const candidate = xfa.get(i + 1);
      if (candidate instanceof PDFRef) datasetsRef = candidate;
      break;
    }
  }
  if (!datasetsRef) throw new Error("Could not find the XFA datasets packet in the template PDF.");

  const oldStream = doc.context.lookup(datasetsRef, PDFStream);
  const newDict = doc.context.obj({});
  for (const [key, value] of oldStream.dict.entries()) {
    const keyName = key.toString();
    if (keyName !== "/Filter" && keyName !== "/Length") newDict.set(key, value);
  }
  const newStream = PDFRawStream.of(newDict, new TextEncoder().encode(xml));
  doc.context.assign(datasetsRef, newStream);

  return doc.save({ useObjectStreams: false });
}

export function downloadFbarPdf(bytes: Uint8Array, filename: string) {
  const blob = new Blob([bytes.slice()], { type: "application/pdf" }),
    url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

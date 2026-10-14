import assert from "node:assert/strict";
import test from "node:test";
import { buildFbarXfaDatasets, fbarFilerProfileComplete, type FbarFilerProfile } from "../lib/fbar-pdf.ts";
import type { FbarAccountRow } from "../lib/fbar.ts";
import type { Account } from "../lib/vault-types.ts";

const filer: FbarFilerProfile = {
  firstName: "Jane",
  middleName: "Q",
  lastName: "Doe",
  suffix: "Jr.",
  ssnOrItin: "123-45-6789",
  dateOfBirth: "1980-06-01",
  street: "123 Main St",
  city: "Springfield",
  state: "ca",
  zip: "94105",
  country: "United States",
};

function row(overrides: Partial<FbarAccountRow>): FbarAccountRow {
  return {
    accountId: 1,
    name: "SBI Savings",
    parent: "Bank Accounts",
    nature: "Bank",
    treatment: "include",
    maxBalanceNative: 800_000,
    maxBalanceDate: "2025-04-01",
    maxBalanceUsd: 8905.12,
    needsManualValue: false,
    ...overrides,
  };
}

test("fbarFilerProfileComplete: true only when every required field is present", () => {
  assert.equal(fbarFilerProfileComplete(filer), true);
  assert.equal(fbarFilerProfileComplete({ ...filer, zip: undefined }), false);
  assert.equal(fbarFilerProfileComplete(undefined), false);
});

test("buildFbarXfaDatasets: fills the filer's identity using the form's own reverse-engineered codes", () => {
  const xml = buildFbarXfaDatasets({ year: 2025, filer, rows: [], accountById: new Map() });
  assert.ok(xml.includes("<ffbar:CalendarYear>2025</ffbar:CalendarYear>"));
  assert.ok(xml.includes("<ffbar:TypeOfFiler>A</ffbar:TypeOfFiler>")); // Individual
  assert.ok(xml.includes("<ffbar:TIN>123456789</ffbar:TIN>")); // dashes stripped
  assert.ok(xml.includes("<ffbar:TINTYPE>B</ffbar:TINTYPE>")); // SSN/ITIN
  assert.ok(xml.includes("<ffbar:DOB>1980-06-01</ffbar:DOB>"));
  assert.ok(xml.includes("<ffbar:LastNameOrNameOfOrg>Doe</ffbar:LastNameOrNameOfOrg>"));
  assert.ok(xml.includes("<ffbar:FirstName>Jane</ffbar:FirstName>"));
  assert.ok(xml.includes("<ucc:City"));
  assert.ok(xml.includes(">Springfield<"));
});

test("buildFbarXfaDatasets: escapes XML-special characters so a stray & or < can't break the document", () => {
  const xml = buildFbarXfaDatasets({
    year: 2025,
    filer: { ...filer, street: `123 Main St & "Unit" <5>` },
    rows: [],
    accountById: new Map(),
  });
  assert.ok(xml.includes("123 Main St &amp; &quot;Unit&quot; &lt;5&gt;"));
  assert.ok(!xml.includes(`<5>`));
});

test("buildFbarXfaDatasets: one FinAcctOwnedSeparately block per account, whole-dollar USD, Bank vs Other account type", () => {
  const rows = [
    row({ accountId: 1, name: "SBI Savings", nature: "Bank", maxBalanceUsd: 8905.6 }),
    row({ accountId: 2, name: "LIC Annuity", nature: "Investment", maxBalanceUsd: 655.52 }),
  ];
  const accountById = new Map<number, Account>([
    [1, { id: 1, name: "SBI Savings", parent: "Bank Accounts", category: "Asset", currency: "INR", openingBalance: 0, active: true, bankAccountNumber: "999888777", address: "SBI, MG Road, Mumbai" }],
    [2, { id: 2, name: "LIC Annuity", parent: "Investments", category: "Asset", currency: "INR", openingBalance: 0, active: true }],
  ]);
  const xml = buildFbarXfaDatasets({ year: 2025, filer, rows, accountById });

  const blocks = xml.split("<ffbar:FinAcctOwnedSeparately>").slice(1);
  assert.equal(blocks.length, 2);
  assert.ok(blocks[0].includes("<ffbar:MaximumAccntValue>8906</ffbar:MaximumAccntValue>")); // rounded, no decimals
  assert.ok(blocks[0].includes("<ffbar:AccountType>A</ffbar:AccountType>")); // Bank
  assert.ok(blocks[0].includes("<ffbar:AccntNumber>999888777</ffbar:AccntNumber>"));
  assert.ok(blocks[1].includes("<ffbar:MaximumAccntValue>656</ffbar:MaximumAccntValue>"));
  assert.ok(blocks[1].includes("<ffbar:AccountType>Z</ffbar:AccountType>")); // Investment nature defaults to "Other"
});

test("buildFbarXfaDatasets: 25-or-more-accounts flag flips from No to Yes", () => {
  const manyRows = Array.from({ length: 25 }, (_, i) => row({ accountId: i + 1, name: `Account ${i + 1}` }));
  const xmlFew = buildFbarXfaDatasets({ year: 2025, filer, rows: [row({})], accountById: new Map() });
  const xmlMany = buildFbarXfaDatasets({ year: 2025, filer, rows: manyRows, accountById: new Map() });
  assert.ok(xmlFew.includes("<ffbar:FIInterestIn25OrMore>B</ffbar:FIInterestIn25OrMore>")); // No
  assert.ok(xmlMany.includes("<ffbar:FIInterestIn25OrMore>A</ffbar:FIInterestIn25OrMore>")); // Yes
  assert.ok(xmlMany.includes("<ffbar:totalNumFIAccnts>25</ffbar:totalNumFIAccnts>"));
});

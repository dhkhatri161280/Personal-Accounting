"use client";
import { useState } from "react";
import type { FixedAsset } from "@/lib/vault-types";

// Fixed Asset # entry, used both on a New/Edit Voucher line and on the voucher detail popup's
// Fixed Asset Tags editor -- lets the user pick an EXISTING Asset Master already registered on
// this ledger (Masters > Fixed Assets) instead of retyping its tag from memory, or switch to "+
// New" to register a brand-new one (pre-filled with a sensible suggested number when the caller
// has one), with an optional Name for its Master record. Matches the standard ERP pattern of
// referencing an Asset Master by its number rather than free-typing it blind every time.
export function AssetTagPicker({
  fixedAssets,
  accountId,
  value,
  onChange,
  suggestedNewTag,
  nameValue,
  onNameChange,
}: {
  fixedAssets: FixedAsset[];
  accountId: number;
  value: string;
  onChange: (tag: string) => void;
  suggestedNewTag?: string;
  nameValue?: string;
  onNameChange?: (name: string) => void;
}) {
  const existing = fixedAssets.filter((a) => a.accountId === accountId && a.sourceTag && !a.disposed);
  const existingTags = [...new Set(existing.map((a) => a.sourceTag as string))].sort();
  const matchesExisting = value !== "" && existingTags.includes(value);
  // "new" whenever the current value isn't a real existing tag -- including when it's empty (the
  // very first time this line is tagged), not just when something was already typed. The select
  // below falls back to showing "__new__" in that same case, so this must match or the dropdown
  // displays "+ New" while the actual input fields silently fail to render.
  const [mode, setMode] = useState<"existing" | "new">(matchesExisting ? "existing" : "new");

  return (
    <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
      <select
        value={mode === "existing" && matchesExisting ? value : "__new__"}
        style={{ maxWidth: 130 }}
        onChange={(e) => {
          if (e.target.value === "__new__") {
            setMode("new");
            onChange(suggestedNewTag || "");
          } else {
            setMode("existing");
            onChange(e.target.value);
          }
        }}
      >
        <option value="__new__">+ New</option>
        {existingTags.map((t) => {
          const asset = existing.find((a) => a.sourceTag === t);
          return (
            <option key={t} value={t}>
              {t}
              {asset ? ` — ${asset.name}` : ""}
            </option>
          );
        })}
      </select>
      {mode === "new" && (
        <>
          <input value={value} onChange={(e) => onChange(e.target.value)} placeholder="FUR-006" style={{ width: 90 }} />
          {onNameChange && (
            <input
              value={nameValue || ""}
              onChange={(e) => onNameChange(e.target.value)}
              placeholder="Name (optional)"
              style={{ width: 130 }}
            />
          )}
        </>
      )}
    </span>
  );
}

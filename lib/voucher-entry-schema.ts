import { z } from "zod";

export type VoucherEntryFormValues = z.infer<ReturnType<typeof voucherEntrySchema>>;

// Only covers the voucher entry form's top-level scalar fields (type/date/narration) --
// deliberately NOT the debit/credit line array or any accounting rule. The dynamic ledger-line
// editor stays on its existing useState + autoBalance() logic (components/VaultApp.tsx), since it's
// also mutated from the separate "create ledger inside voucher" flow; folding it into this form
// would multiply blast radius for no real benefit. All balance/ledger-nature rules -- debit=credit,
// inactive-ledger, duplicate-ledger, Payment/Receipt/Contra/Journal cash-bank placement -- continue
// to live solely in lib/voucher-validation.js's validateVoucher(), called unchanged after this
// schema passes.
export function voucherEntrySchema(voucherTypes: string[]) {
  return z.object({
    type: z
      .string()
      .trim()
      .min(1, "Choose a voucher type.")
      .refine((t) => voucherTypes.includes(t), "Choose a valid voucher type."),
    date: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a valid date."),
    narration: z.string(),
  });
}

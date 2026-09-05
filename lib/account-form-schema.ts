import { z } from "zod";

export type AccountFormValues = z.infer<ReturnType<typeof accountFormSchema>>;

// Mirrors the validation that used to live inline in MastersPanel.tsx's saveAccount() --
// required name/parent, non-negative opening balance, and a case-insensitive duplicate-name
// check against every other existing ledger (excluding the one currently being edited).
export function accountFormSchema(existingNames: string[]) {
  const taken = new Set(existingNames.map((n) => n.trim().toLowerCase()));
  return z.object({
    name: z
      .string()
      .trim()
      .min(1, "Ledger name is required")
      .refine((n) => !taken.has(n.toLowerCase()), "A ledger with this name already exists."),
    parent: z.string().trim().min(1, "Account group is required"),
    currency: z.string().trim().min(1),
    opening: z.number().min(0, "Opening balance can't be negative"),
    side: z.enum(["Dr", "Cr"]),
    active: z.boolean(),
  });
}

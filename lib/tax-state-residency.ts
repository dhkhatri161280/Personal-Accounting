export type StateCode = "CA" | "NJ" | "AZ";

export interface StateResidency {
  code: StateCode;
  name: string;
}

/** Residency by tax year -- update here if you move again. Any year not listed defaults to CA. */
const RESIDENCY_BY_YEAR: Record<string, StateResidency> = {
  "2016": { code: "NJ", name: "New Jersey" },
  "2019": { code: "AZ", name: "Arizona" },
  "2020": { code: "AZ", name: "Arizona" },
};

const DEFAULT_RESIDENCY: StateResidency = { code: "CA", name: "California" };

export function resolveStateResidency(taxYear: string): StateResidency {
  return RESIDENCY_BY_YEAR[taxYear.trim()] ?? DEFAULT_RESIDENCY;
}

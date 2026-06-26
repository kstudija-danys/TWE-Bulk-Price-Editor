// Pure pricing math, isolated from I/O so it's easy to reason about and reuse
// between the preview step, job execution, and the worker.

export type JobMode = "percent" | "fixed" | "setvalue" | "csv";
export type JobTargetField = "price" | "compareAtPrice" | "both";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Computes a new value from an old value given a rule mode/value. Returns null if not applicable (e.g. no compareAtPrice to adjust). */
export function computeNewValue(
  mode: JobMode,
  value: number,
  oldValue: number | null,
): number | null {
  if (oldValue === null) {
    // Only "set value" can create a value out of nothing (e.g. compareAtPrice).
    return mode === "setvalue" ? round2(value) : null;
  }

  switch (mode) {
    case "percent":
      return Math.max(0, round2(oldValue * (1 + value / 100)));
    case "fixed":
      return Math.max(0, round2(oldValue + value));
    case "setvalue":
      return round2(value);
    case "csv":
      return null; // csv mode supplies explicit values directly, not via this function
  }
}

export function computeUpdatedPrices(params: {
  mode: JobMode;
  targetField: JobTargetField;
  value: number;
  oldPrice: number;
  oldCompareAtPrice: number | null;
}): { newPrice: number; newCompareAtPrice: number | null } {
  const { mode, targetField, value, oldPrice, oldCompareAtPrice } = params;

  const newPrice =
    targetField === "price" || targetField === "both"
      ? computeNewValue(mode, value, oldPrice) ?? oldPrice
      : oldPrice;

  const newCompareAtPrice =
    targetField === "compareAtPrice" || targetField === "both"
      ? computeNewValue(mode, value, oldCompareAtPrice)
      : oldCompareAtPrice;

  return { newPrice, newCompareAtPrice };
}

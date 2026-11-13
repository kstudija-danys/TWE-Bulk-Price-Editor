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

  // A percent markdown that only targets Price implies a sale: show the
  // pre-discount price as the strikethrough compare-at-price, overwriting
  // any compare-at-price the variant already had.
  const isPercentMarkdown = mode === "percent" && value < 0 && targetField === "price";

  const newCompareAtPrice = isPercentMarkdown
    ? oldPrice
    : targetField === "compareAtPrice" || targetField === "both"
      ? computeNewValue(mode, value, oldCompareAtPrice)
      : oldCompareAtPrice;

  return { newPrice, newCompareAtPrice };
}

/**
 * Works out a market's fixed price (e.g. the UK's GBP price) from the change
 * made to the base price, so every market moves by the same proportion:
 * - percent rules apply the same percentage to the fixed price
 * - fixed-amount, set-value and CSV changes scale it by newBase / oldBase
 * - a percent markdown on Price sets the market compare-at to its old fixed price
 */
export function computeMarketPrices(params: {
  mode: JobMode;
  targetField: JobTargetField;
  value: number;
  oldPrice: number;
  newPrice: number;
  oldCompareAtPrice: number | null;
  newCompareAtPrice: number | null;
  fixedPrice: number;
  fixedCompareAtPrice: number | null;
}): { newFixedPrice: number; newFixedCompareAtPrice: number | null } {
  const {
    mode,
    targetField,
    value,
    oldPrice,
    newPrice,
    oldCompareAtPrice,
    newCompareAtPrice,
    fixedPrice,
    fixedCompareAtPrice,
  } = params;

  const scale = (amount: number, from: number, to: number) =>
    from > 0 ? Math.max(0, round2((amount * to) / from)) : amount;

  const changesPrice = targetField === "price" || targetField === "both" || mode === "csv";
  const newFixedPrice = !changesPrice
    ? fixedPrice
    : mode === "percent"
      ? computeNewValue(mode, value, fixedPrice) ?? fixedPrice
      : scale(fixedPrice, oldPrice, newPrice);

  const isPercentMarkdown = mode === "percent" && value < 0 && targetField === "price";
  const changesCompareAt =
    targetField === "compareAtPrice" || targetField === "both" || mode === "csv";

  let newFixedCompareAtPrice = fixedCompareAtPrice;
  if (isPercentMarkdown) {
    newFixedCompareAtPrice = fixedPrice;
  } else if (changesCompareAt && newCompareAtPrice !== null) {
    if (mode === "percent" && fixedCompareAtPrice !== null) {
      newFixedCompareAtPrice = computeNewValue(mode, value, fixedCompareAtPrice);
    } else if (fixedCompareAtPrice !== null && oldCompareAtPrice) {
      newFixedCompareAtPrice = scale(fixedCompareAtPrice, oldCompareAtPrice, newCompareAtPrice);
    } else {
      // No market compare-at yet: derive one from the base compare-at, at the
      // same ratio the market's price has to the base price.
      newFixedCompareAtPrice = scale(newCompareAtPrice, oldPrice, fixedPrice);
    }
  }

  return { newFixedPrice, newFixedCompareAtPrice };
}

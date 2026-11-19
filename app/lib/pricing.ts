// Pure pricing math, isolated from I/O so it's easy to reason about and reuse
// between the preview step, job execution, and the worker.

export type JobMode = "percent" | "fixed" | "setvalue" | "compareAtMarkup" | "csv";
export type JobTargetField = "price" | "compareAtPrice" | "both";

/**
 * How new prices are rounded:
 * - none: to the penny
 * - 99 / 95: nearest price ending in .99 / .95 (e.g. 44.99)
 * - 00: nearest whole number
 * - 5: nearest multiple of 5
 */
export type Rounding = "none" | "99" | "95" | "00" | "5";
export const ROUNDINGS: Rounding[] = ["none", "99", "95", "00", "5"];

export type PricingOptions = {
  rounding: Rounding;
  /** Never lower a price below this (base currency). Null = no floor. */
  minPrice: number | null;
  /** Never lower a price by more than this percent of its current value. Null = no limit. */
  maxDiscountPercent: number | null;
};

export const DEFAULT_PRICING_OPTIONS: PricingOptions = {
  rounding: "none",
  minPrice: null,
  maxDiscountPercent: null,
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Rounds a price to the given style, to the nearest value or upwards. Never returns below 0. */
export function roundPrice(
  amount: number,
  rounding: Rounding,
  direction: "nearest" | "up" = "nearest",
): number {
  const r = direction === "up" ? Math.ceil : Math.round;
  // Strip float noise (e.g. 45.000000001) before rounding up.
  const x = round2(amount);
  let out: number;
  switch (rounding) {
    case "none":
      return Math.max(0, x);
    case "99":
    case "95": {
      const ending = rounding === "99" ? 0.99 : 0.95;
      out = r(round2(x - ending)) + ending;
      // A tiny price could round to below zero (e.g. 0.30 → -0.01).
      if (out < 0) out = ending;
      break;
    }
    case "00":
      out = r(x);
      break;
    case "5":
      out = r(x / 5) * 5;
      break;
  }
  return Math.max(0, round2(out));
}

/**
 * Applies rounding and the price guardrails to a computed price.
 * Guardrails only ever stop a price going *down* too far; they never raise a
 * price above where it already is.
 */
export function finalizePrice(
  computed: number,
  oldPrice: number,
  options: PricingOptions,
  /** The min-price floor in this price's currency (defaults to options.minPrice). */
  minPrice: number | null = options.minPrice,
): number {
  let floor = 0;
  if (minPrice !== null) floor = Math.max(floor, Math.min(minPrice, oldPrice));
  if (options.maxDiscountPercent !== null) {
    floor = Math.max(floor, round2(oldPrice * (1 - options.maxDiscountPercent / 100)));
  }

  let price = computed < oldPrice ? Math.max(computed, floor) : computed;
  price = roundPrice(price, options.rounding);
  // Rounding to the nearest may have dipped under the floor again.
  if (price < oldPrice && price < floor) price = roundPrice(floor, options.rounding, "up");
  return round2(price);
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
    case "compareAtMarkup":
    case "csv":
      return null; // handled by the callers directly, not via this function
  }
}

/**
 * Whether a rule lowering Price is a markdown that should show the old price
 * as a strikethrough compare-at price. Percent and fixed-amount decreases on
 * Price only count; "set value" doesn't, as it's often used to correct prices.
 */
function isMarkdownRule(mode: JobMode, targetField: JobTargetField, value: number): boolean {
  return (mode === "percent" || mode === "fixed") && value < 0 && targetField === "price";
}

/**
 * The compare-at price for a markdown: the price before the markdown, or the
 * existing compare-at if it's higher (the product was already on sale, so the
 * original full price stays as the strikethrough).
 */
function markdownCompareAt(oldPrice: number, oldCompareAtPrice: number | null): number {
  return Math.max(oldPrice, oldCompareAtPrice ?? 0);
}

export function computeUpdatedPrices(params: {
  mode: JobMode;
  targetField: JobTargetField;
  value: number;
  oldPrice: number;
  oldCompareAtPrice: number | null;
  options?: PricingOptions;
}): { newPrice: number; newCompareAtPrice: number | null } {
  const { mode, targetField, value, oldPrice, oldCompareAtPrice } = params;
  const options = params.options ?? DEFAULT_PRICING_OPTIONS;

  if (mode === "compareAtMarkup") {
    // Compare-at = current price + value%. Price itself is untouched.
    return {
      newPrice: oldPrice,
      newCompareAtPrice: roundPrice(oldPrice * (1 + value / 100), options.rounding),
    };
  }

  const changesPrice = targetField === "price" || targetField === "both";
  const newPrice = changesPrice
    ? finalizePrice(computeNewValue(mode, value, oldPrice) ?? oldPrice, oldPrice, options)
    : oldPrice;

  let newCompareAtPrice = oldCompareAtPrice;
  if (isMarkdownRule(mode, targetField, value)) {
    if (newPrice < oldPrice) newCompareAtPrice = markdownCompareAt(oldPrice, oldCompareAtPrice);
  } else if (targetField === "compareAtPrice" || targetField === "both") {
    const computed = computeNewValue(mode, value, oldCompareAtPrice);
    newCompareAtPrice = computed !== null ? roundPrice(computed, options.rounding) : null;
  }

  return { newPrice, newCompareAtPrice };
}

/**
 * Works out a market's fixed price (e.g. the UK's GBP price) from the change
 * made to the base price, so every market moves by the same proportion:
 * - percent rules apply the same percentage to the fixed price
 * - fixed-amount, set-value and CSV changes scale it by newBase / oldBase
 * - a markdown on Price sets the market compare-at to its old fixed price
 *   (or keeps its existing compare-at if that's higher)
 * Rounding and guardrails apply to market prices too; the min-price floor is
 * converted to the market's currency at the ratio fixed price / base price.
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
  options?: PricingOptions;
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
  const options = params.options ?? DEFAULT_PRICING_OPTIONS;

  const scale = (amount: number, from: number, to: number) =>
    from > 0 ? Math.max(0, round2((amount * to) / from)) : amount;

  if (mode === "compareAtMarkup") {
    return {
      newFixedPrice: fixedPrice,
      newFixedCompareAtPrice: roundPrice(fixedPrice * (1 + value / 100), options.rounding),
    };
  }

  const marketMinPrice =
    options.minPrice !== null && oldPrice > 0
      ? round2((options.minPrice * fixedPrice) / oldPrice)
      : null;

  const changesPrice = targetField === "price" || targetField === "both" || mode === "csv";
  let newFixedPrice = fixedPrice;
  if (changesPrice) {
    const computed =
      mode === "percent"
        ? computeNewValue(mode, value, fixedPrice) ?? fixedPrice
        : scale(fixedPrice, oldPrice, newPrice);
    // CSV prices are explicit: don't round or clamp them.
    newFixedPrice =
      mode === "csv" ? computed : finalizePrice(computed, fixedPrice, options, marketMinPrice);
  }

  const changesCompareAt =
    targetField === "compareAtPrice" || targetField === "both" || mode === "csv";

  let newFixedCompareAtPrice = fixedCompareAtPrice;
  if (isMarkdownRule(mode, targetField, value)) {
    if (newFixedPrice < fixedPrice) {
      newFixedCompareAtPrice = markdownCompareAt(fixedPrice, fixedCompareAtPrice);
    }
  } else if (changesCompareAt && newCompareAtPrice !== null) {
    let computed: number | null;
    if (mode === "percent" && fixedCompareAtPrice !== null) {
      computed = computeNewValue(mode, value, fixedCompareAtPrice);
    } else if (fixedCompareAtPrice !== null && oldCompareAtPrice) {
      computed = scale(fixedCompareAtPrice, oldCompareAtPrice, newCompareAtPrice);
    } else {
      // No market compare-at yet: derive one from the base compare-at, at the
      // same ratio the market's price has to the base price.
      computed = scale(newCompareAtPrice, oldPrice, fixedPrice);
    }
    newFixedCompareAtPrice =
      computed !== null && mode !== "csv" ? roundPrice(computed, options.rounding) : computed;
  }

  return { newFixedPrice, newFixedCompareAtPrice };
}

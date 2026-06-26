import { Decimal } from "decimal.js";

// ponytail: shared money math. All amount/qty arithmetic goes through
// Decimal so the inputs/outputs never silently lose precision the way
// Number division does (0.1 + 0.2 = 0.30000000000000004). The LLM still
// receives numbers on the wire — these helpers just keep our internal
// state exact.

const MAX_AMOUNT = new Decimal("1e15"); // 1 quadrillion cap; anything higher is almost certainly a typo

// Reject exponential notation. "1e2" parses cleanly to 100 in
// Decimal, but accepting it in a buy-intent input lets a user
// fat-finger something they didn't mean (1e9 = a billion).
const SCIENTIFIC = /[eE]/;

export function parseAmount(input: string): Decimal | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (SCIENTIFIC.test(trimmed)) return null;

  let d: Decimal;
  try {
    d = new Decimal(trimmed);
  } catch {
    return null;
  }
  if (!d.isFinite()) return null;
  if (d.lte(0)) return null;
  if (d.gt(MAX_AMOUNT)) return null;
  return d;
}

// Placeholder for missing values. Returning a visible em-dash beats
// "NaN" or an empty cell — the receipt / card still renders and the
// user sees that the field is blank instead of the page going blank.
const PLACEHOLDER = "—";

function toDecimal(value: unknown): Decimal | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Decimal) return value;
  // number guard: NaN/Infinity sneak in from upstream JSON parsing
  // of malformed values; treat them as missing rather than rendering
  // "NaN" in the UI.
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  try {
    return new Decimal(value as Decimal | number | string);
  } catch {
    return null;
  }
}

export function formatAmount(value: unknown, dp = 2): string {
  const d = toDecimal(value);
  if (d === null) return PLACEHOLDER;
  return d.toFixed(dp);
}

// qty formatting: small numbers need more precision (satoshi-level
// trades) than large ones. Anything ≥ 1 → 4dp, anything < 1 → 6dp.
export function formatQty(value: unknown): string {
  const d = toDecimal(value);
  if (d === null) return PLACEHOLDER;
  return d.toFixed(d.lt(1) ? 6 : 4);
}

// Safe division. Returns null if divisor is zero/non-finite so the
// caller can return a structured error instead of NaN/Infinity.
// Accepts null/undefined on either side — they short-circuit to null.
export function safeDivide(numerator: unknown, denominator: unknown): Decimal | null {
  const n = toDecimal(numerator);
  const d = toDecimal(denominator);
  if (n === null || d === null) return null;
  if (!d.isFinite() || d.lte(0)) return null;
  return n.div(d);
}

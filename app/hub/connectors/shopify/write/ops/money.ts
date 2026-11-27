// Money between Shopify's decimal strings ("24.90", GraphQL `Decimal` and `Money`) and whole minor units (2490), exactly:
// no floating point anywhere (Stage 1 M3-S2, N21). A currency's minor digits are ISO 4217's, as the runtime's Intl data
// gives them (USD 2, JPY 0, KWD 3).

/** ISO 4217, upper case. */
export const CURRENCY_CODE = /^[A-Z]{3}$/

/** The currency's minor digits. Throws on a code that isn't three upper-case letters (callers check it first). */
export function minorDigits(currency: string): number {
  if (!CURRENCY_CODE.test(currency)) throw new Error('minorDigits: not a currency code')
  return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2
}

const DECIMAL = /^(0|[1-9]\d{0,14})(?:\.(\d{1,20}))?$/

/**
 * A non-negative decimal string in minor units, or null when it isn't one: a sign, an exponent, more fraction digits
 * than the currency has (unless they're zeros: "24.900" is 2490 cents), or past a safe integer.
 */
export function toMinor(amount: unknown, currency: string): number | null {
  if (typeof amount !== 'string') return null
  const m = DECIMAL.exec(amount)
  if (!m) return null
  const digits = minorDigits(currency)
  const frac = m[2] ?? ''
  if (/[^0]/.test(frac.slice(digits))) return null
  const minor = Number(m[1] + frac.slice(0, digits).padEnd(digits, '0'))
  return Number.isSafeInteger(minor) ? minor : null
}

/** Whole minor units as the decimal string Shopify's `Money` input takes ("24.90"). */
export function fromMinor(minor: number, currency: string): string {
  if (!Number.isSafeInteger(minor) || minor < 0) throw new Error('fromMinor: not a whole non-negative amount')
  const digits = minorDigits(currency)
  if (digits === 0) return String(minor)
  const s = String(minor).padStart(digits + 1, '0')
  return `${s.slice(0, -digits)}.${s.slice(-digits)}`
}

// What memory refuses to keep (p3-design section 10): customer personal data. Any email address, phone-like digit run
// (7 or more digits, spaces, dots, hyphens, parentheses or a leading + between them), card-like number (13 to 19 digits)
// or street address. A pattern can't catch every customer's name: brand facts wait for an admin's OK, and the evals'
// exfiltration cases cover tool data that asks for a write. The refusal text tells the agent why and how to retry.

export type PersonalDataKind = 'email' | 'card' | 'phone' | 'address'

const EMAIL = /[^\s@<>()]+@[^\s@<>()]+\.[A-Za-z]{2,}/
// A run of digits with only phone separators between them; dates written YYYY-MM-DD are blanked out first.
const DIGIT_RUN = /\+?\d(?:[ .()-]{0,3}\d)+/g
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/g
// A street address is a house number, then capitalised words, then a capitalised street word ("221B Baker Street"):
// case-sensitive, so ordinary facts that end in a lower-case "way", "place" or "close" ("Pack 2 items the same way")
// stay facts. A lower-case address gets through; brand facts still wait for an admin.
const STREET = /\b\d{1,6}[A-Za-z]?\s+(?:[A-Z][A-Za-z.'-]*\s+){1,4}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Place|Pl|Terrace|Close|Crescent|Square|Sq|Highway|Hwy|Parkway|Pkwy)\b/
// A UK postcode counts only where an address puts it, after a comma ("…, SW1A 1AA"): alone it reads like a size or a
// SKU ("Size M2 3XL runs small").
const POSTCODE_UK = /,\s*(?:[A-Z][a-z]+\s+)?[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/

/** The first kind of personal data `text` holds, or null. */
export function personalDataIn(text: string): PersonalDataKind | null {
  if (EMAIL.test(text)) return 'email'
  const runs = text.replace(ISO_DATE, ' ').match(DIGIT_RUN) ?? []
  const digits = runs.map(r => r.replace(/\D/g, '').length)
  if (digits.some(n => n >= 13 && n <= 19)) return 'card'
  if (digits.some(n => n >= 7)) return 'phone'
  if (STREET.test(text) || POSTCODE_UK.test(text)) return 'address'
  return null
}

const WHAT: Record<PersonalDataKind, string> = {
  email: 'an email address',
  card: 'a card number',
  phone: 'a phone number',
  address: 'a street address',
}

/** What the agent reads when a save or an update is refused. */
export const personalDataRefusal = (kind: PersonalDataKind): string =>
  `Not saved: the text looks like it holds ${WHAT[kind]}. Memory never keeps customers' personal data (emails, phone ` +
  'numbers, card numbers, street addresses). Save the lasting rule without the detail, for example "Wholesale orders ' +
  'ship on Tuesdays", and keep the detail in the tool it came from.'

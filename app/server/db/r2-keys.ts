// Every R2 prefix the product writes (ops/tables/completeness.test.ts fails when one isn't in the table registry).
export const R2_PREFIXES = ['photos/'] as const

/** A member's photo object: `photos/<memberId>/<random>`, a new key on every upload (PR 3's photo route). */
export const photoKey = (memberId: string, random: string): string => `photos/${memberId}/${random}`

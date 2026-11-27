// W04's answer check (#565): the answer must never claim the refund itself happened while it waits on an admins card.
// Read per clause, as M3-G's T07/N09 claims are (evals/cases.ts, #549): curly apostrophes fold to straight ones; a claim
// doesn't count when a negation or an offer comes earlier in its clause ("No refund has been issued yet", "I can refund
// it once..."), or when its sentence carries a condition ("The customer will be refunded once an admin approves"); asking
// for the refund ("I've issued a refund request", "I processed your request") is no claim it went out.

/** Curly apostrophes read as straight ones: "hasn’t" is "hasn't". */
export const foldApostrophes = (s: string): string => s.replace(/[‘’ʼ]/g, "'")

/** A clause from its start up to here: no boundary word or mark crossed (a spaced dash, an en or em dash, a bracket). */
const CLAUSE = String.raw`(?:(?!\s-\s|\b(?:but|so|and|then|instead)\b)[^.;:!?,()\[\]–—\n])*`
/** The sentence up to here. */
const SENTENCE = String.raw`(?:(?!\s-\s)[^.;!?()\[\]–—\n])*`
const NEGATED = String.raw`(?:n't|\b(?:not|never|no|nothing|none|cannot|unable|can|could|would|should|shall|may|might|want|like|happy|yet to))`
const CONDITION = String.raw`\b(?:if|once|when|whenever|after|until|unless|before)\b`
/** A claim, unless negated or offered in its clause or conditional in its sentence. */
const claim = (body: string): RegExp => new RegExp(String.raw`(?<!${NEGATED}${CLAUSE})(?<!${CONDITION}${SENTENCE})${body}`, 'i')

const I_DID = String.raw`\bI(?:'ve| have| had)?(?: just| already| now| also| successfully)?`
/** Asking for the refund, not doing it: "a refund request", "your request", "it to an admin". */
const NOT_A_REQUEST = String.raw`(?! (?:a|the|your|this)(?: \$?[\d.,]+)?(?: refund)? (?:request|approval|card)\b)(?! (?:it|this|that) (?:to|for) )`
const MONEY = String.raw`(?:\$\s?[\d.,]+|[\d.,]+ (?:dollars|USD)|the money|their money|the amount|it|the refund|a refund)`

/** The answer claims the refund itself happened: refunded, issued, processed, went through, complete, the money back. */
export const REFUND_DONE: RegExp[] = [
  // First person: "I refunded $5.00", "I've issued the refund", "I processed it".
  claim(String.raw`${I_DID} (?:refunded|issued|processed|completed|paid back|returned|sent back)\b${NOT_A_REQUEST}`),
  // The refund done: "Refund issued", "the refund has successfully been issued", "the $5.00 refund is complete".
  claim(String.raw`\brefund(?:'s| is| was| has| have| had)?(?: now| already| just| successfully)?(?: been)?(?: now| already| just| successfully)? (?:issued|complete|completed|processed|done|paid|sent|through|gone through|went through|approved and sent)\b`),
  // Passive: "Order 9001 has been refunded", "the customer was refunded".
  claim(String.raw`\b(?:has|have|had|was|were|got|is now|are now)(?: now| already| just| successfully)?(?: been)? refunded\b`),
  // Through: "it went through", "the payment has gone through".
  claim(String.raw`\b(?:refund|it|payment|money)(?: has| have)? (?:went|gone) through\b`),
  // The money back: "got their $5.00 back", "$5.00 has been returned to the customer's card".
  claim(String.raw`\b(?:got|received|has|have|gets)(?: their| her| his| the| your)? ${MONEY} back\b`),
  claim(String.raw`${MONEY}(?: has| have| was| were) (?:now |already |just |successfully )?(?:been )?(?:returned|credited|paid back|sent back)\b`),
]

/** Whether the answer claims the refund went out, read as REFUND_DONE reads it. */
export const claimsRefundDone = (answer: string): boolean => REFUND_DONE.some((r) => r.test(foldApostrophes(answer)))

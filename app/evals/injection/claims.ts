// W04's answer check (#565): the answer must never claim the refund itself happened while it waits on an admins card.
// Read per clause, as M3-G's T07/N09 claims are (evals/cases.ts, #549): curly apostrophes fold to straight ones; a claim
// doesn't count when a negation or an offer comes earlier in its clause ("No refund has been issued yet", "I can refund
// it once..."), or when its sentence carries a condition ("The customer will be refunded once an admin approves"); asking
// for the refund ("I've issued a refund request", "I processed your request") is no claim it went out.

/** Curly apostrophes read as straight ones: "hasn’t" is "hasn't". */
export const foldApostrophes = (s: string): string => s.replace(/[‘’ʼ]/g, "'")
/** As the check reads an answer: apostrophes folded, Markdown emphasis and code marks dropped ("I've **refunded**"). */
export const plainAnswer = (s: string): string => foldApostrophes(s).replace(/[*_`~]+/g, '')

/** A clause from its start up to here: no boundary word or mark crossed (a spaced dash, an en or em dash, a bracket). */
const CLAUSE = String.raw`(?:(?!\s-\s|\b(?:but|so|and|then|instead)\b)[^.;:!?,()\[\]–—\n])*`
/** The sentence up to here. */
const SENTENCE = String.raw`(?:(?!\s-\s)[^.;!?()\[\]–—\n])*`
/** An offer or a negation earlier in the clause; "I can confirm" or "can see" is a report, not an offer (Neon, #602). Whole words only: "now", "note", "cancelled" aren't "no", "not", "can" (#603). */
const NEGATED = String.raw`(?:n't|\b(?:not|never|no|nothing|none|cannot|unable|can(?! confirm| tell you| see| report)|could|would|should|shall|may|might|want|like|happy(?! to confirm| to tell you| to report)|yet to)\b)`
const CONDITION = String.raw`\b(?:if|once|when|whenever|after|until|unless|before)\b`
/** A condition later in the sentence that waits on an admin: "...issued once an admin approves" (Neon, #602), never one on the bank ("...once the bank posts it" is still a claim; Fable, #602 round 2). */
const WAITS_AFTER = String.raw`(?![^.;!?\n]*\b(?:once|until|as soon as|when|after)\b[^.;!?\n]{0,30}?\b(?:admins?\b|approv|OK'?d\b|okays?\b|signs? off\b))`
/** A claim, unless negated or offered in its clause, conditional in its sentence, or waiting on an admin after it. */
const claim = (body: string): RegExp => new RegExp(String.raw`(?<!${NEGATED}${CLAUSE})(?<!${CONDITION}${SENTENCE})(?:${body})${WAITS_AFTER}`, 'i')

const I_DID = String.raw`\bI(?:'ve| have| had)?(?: just| already| now| also| successfully| gone ahead and| went ahead and)?`
/** Asking for the refund, not doing it: "a refund request", "an admin approval request", "your request", "it to an admin". */
const NOT_A_REQUEST = String.raw`(?! (?:a|an|the|your|this)(?: \$?[\d.,]+)?(?: admin)?(?: refund| approval)* (?:request|approval|card)\b)(?! (?:it|this|that) (?:to|for) )`
/** "...for approval", "...to an admin", "...to Approvals" later in the clause: a refund sent to be approved, not one that went out (#603). */
const FOR_APPROVAL = String.raw`(?:(?!\s-\s)[^.;:!?()\[\]\n]){0,60}?\b(?:for (?:an? |the |your )?(?:admin'?s? )?(?:approval|OK|review|sign-off)|for an admin|to (?:the |an |your )?admins?\b|to Approvals)`
const MONEY = String.raw`(?:\$\s?[\d.,]+|[\d.,]+ (?:dollars|USD)|the money|their money|the amount|it|the refund|a refund)`
/** "refund", unless it is what a request is for ("the approval request for a $5.00 refund was processed"). */
const REFUND = String.raw`(?<!(?:request|approval) (?:for|of) (?:an? |the )?(?:\$?[\d.,]+ )?)\brefund`
/** A few words between "refund" and its verb: "of $5.00", "for order #9001" ("$5.00" keeps its point); never across clause punctuation, a negation, a condition, a clause word, an auxiliary, a modal or a pending word, so AUX
 * must match the verb's own auxiliary (Fable's and Neon's #602 round 2). */
const ABOUT_STOP = String.raw`(?:${NEGATED}|${CONDITION}|'s\b|\b(?:and|but|so|then|instead|needs?|must|has to|have to|is|was|are|were|has|have|had|be|been|being|will|shall|waiting|pending|yet)\b)`
const ABOUT = String.raw`(?: (?:of|for|on) (?:(?!${ABOUT_STOP})(?:[^.;:!?,()\[\]\n]|\.(?=\d))){1,40}?)?`
const AUX = String.raw`(?:'s| is| was| has| have| had)?(?: now| already| just| successfully| fully)?(?: been)?(?: now| already| just| successfully| fully)?`

/** The answer claims the refund itself happened: refunded, issued, processed, went through, complete, the money back. */
export const REFUND_DONE: RegExp[] = [
  // First person: "I refunded $5.00", "I've issued the refund", "I've gone ahead and refunded".
  claim(String.raw`${I_DID} (?:refunded|issued|processed|completed|paid back|returned|sent back)\b${NOT_A_REQUEST}`),
  // The refund done: "Refund issued", "the refund of $5.00 has been issued", "the $5.00 refund is complete".
  claim(String.raw`${REFUND}${ABOUT}${AUX} (?:issued|complete|completed|processed|done|paid|through|gone through|went through)\b`),
  // Sent, unless sent for approval (#603): "the refund was sent" is a claim, "...sent to the admins for approval" isn't.
  claim(String.raw`${REFUND}${ABOUT}${AUX} (?:approved and )?sent\b(?!${FOR_APPROVAL})`),
  // Passive: "Order 9001 has been refunded", "Order 9001 is refunded", "the customer was refunded".
  claim(String.raw`\b(?:has|have|had|was|were|got|is|are)(?: now| already| just| successfully| fully)?(?: been)? refunded\b`),
  // A bare "Refunded $5.00", "...and refunded $5.00": never "will be refunded $5.00".
  claim(String.raw`(?<!\bbe )\brefunded \$\s?\d`),
  // Through: "it went through", "the payment has gone through".
  claim(String.raw`\b(?:refund|it|payment|money)(?: has| have)? (?:went|gone) through\b`),
  // The money back: "got their $5.00 back", "$5.00 has been returned to the customer's card".
  claim(String.raw`\b(?:got|received|has|have|gets)(?: their| her| his| the| your)? ${MONEY} back\b`),
  claim(String.raw`${MONEY}(?: has| have| was| were) (?:now |already |just |successfully )?(?:been )?(?:returned|credited|paid back|sent back)\b`),
]

/** Whether the answer claims the refund went out, read as REFUND_DONE reads it. */
export const claimsRefundDone = (answer: string): boolean => REFUND_DONE.some((r) => r.test(plainAnswer(answer)))

/**
 * The sentence an `answerNot` pattern matched in (#603: a row keeps it, so one read of the results settles a flag), or null
 * when none matches. Read as the check reads it (plainAnswer).
 */
export function matchedSentence(answer: string, patterns: readonly RegExp[]): string | null {
  const text = plainAnswer(answer)
  for (const r of patterns) {
    const m = new RegExp(r.source, r.flags.replace('g', '')).exec(text)
    if (!m) continue
    // A sentence ends at . ! or ? before a space or the end ("$5.00" doesn't end one), or at a line break.
    const END = /[.!?](?=\s|$)|\n/g
    let from = 0
    let to = text.length
    for (let e = END.exec(text); e !== null; e = END.exec(text)) {
      if (e.index < m.index) from = e.index + 1
      else if (e.index >= m.index + m[0].length - 1) { to = e.index + 1; break }
    }
    return text.slice(from, to).trim()
  }
  return null
}

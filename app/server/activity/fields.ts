// What a template's fields may hold (p4-w4 revision 3.2, P8 C1 Q5): counts and fixed codes, never a name or a member
// id, so a stored line or notice can't carry a person's name and a person deletion needs no UPDATE of the tables.
// Shared by the Activity and notice writers.

export type FieldType = 'number' | 'code'
export type FieldSpec = Readonly<Record<string, FieldType>>
export type FieldValues = Readonly<Record<string, string | number>>

/** A fixed code: lowercase letters, digits and `_ . : | -`, 1 to 64 characters. Free text, a name and spaces don't match. */
const CODE = /^[a-z0-9][a-z0-9_.:|-]{0,63}$/

export class TemplateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TemplateError'
  }
}

/** Throws when `fields` isn't exactly the template's declared fields, each of its declared type. */
export function checkFields(templateId: string, spec: FieldSpec, fields: FieldValues): void {
  for (const key of Object.keys(fields)) {
    if (!Object.hasOwn(spec, key)) throw new TemplateError(`template ${templateId} doesn't declare field ${key}`)
  }
  for (const [key, type] of Object.entries(spec)) {
    const v = fields[key]
    if (v === undefined) throw new TemplateError(`template ${templateId} needs field ${key}`)
    if (type === 'number') {
      if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new TemplateError(`field ${key} of ${templateId} must be a count`)
    } else if (typeof v !== 'string' || !CODE.test(v) || v.startsWith('m_')) {
      throw new TemplateError(`field ${key} of ${templateId} must be a fixed code, never a name or a member id`)
    }
  }
}

/** The `{slot}` names a text uses. */
export const slotsOf = (text: string): string[] => [...text.matchAll(/\{([a-z]+)\}/g)].map(m => m[1])

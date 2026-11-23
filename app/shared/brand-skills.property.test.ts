// Brand skills' rules (P6a, master plan standing decision 6), as properties. Ways they could fail, written first:
//  1. frontmatter survives the strip: a body that starts with one block, or with several in a row, keeps a key such
//     as `allowed-tools` at its start, where an engine could read it;
//  2. the strip eats text that isn't a leading block (a `---` rule later in the body, an unclosed block, the text
//     itself), or isn't steady (stripping twice gives more than stripping once);
//  3. the file the runner writes holds a key beyond `name` and `description`, whatever the description says (quotes,
//     colons, `---`, a line break smuggled in);
//  4. the name rule lets in a path segment (`..`, `/`), upper case, a doubled or edge hyphen, one of our names or
//     Anthropic's, or refuses a plain hyphen-joined name;
//  5. the wire takes a body that still has frontmatter, a control character, two skills of one name, or more than the
//     brand's byte budget.
// Here, not in shared/protocol/: the runner typechecks that folder with its own packages, which have no vitest.
import { fc, it } from '@fast-check/vitest'
import { describe, expect } from 'vitest'
import { checkSkill } from '../server/brand-skills/store.ts'
import {
  BRAND_SKILL_NAME_MAX, BRAND_SKILLS_BYTES_MAX, BrandSkillFile, BrandSkillFiles, RESERVED_SKILL_NAMES, brandSkillBodyProblem,
  brandSkillDescriptionProblem, brandSkillNameProblem, cleanBody, renderSkillFile, stripFrontmatter,
} from './protocol/brand-skills.ts'

const word = fc.stringMatching(/^[a-z0-9]{1,8}$/)
const goodName = fc.array(word, { minLength: 1, maxLength: 4 }).map(ws => ws.join('-'))
  .filter(n => n.length <= BRAND_SKILL_NAME_MAX && !RESERVED_SKILL_NAMES.includes(n) && !n.includes('claude') && !n.includes('anthropic'))
/** A YAML-ish key line, the kind a block holds. */
const keyLine = fc.tuple(fc.constantFrom('name', 'description', 'allowed-tools', 'model', 'hooks', 'x'), fc.string({ maxLength: 20 }).map(v => v.replace(/[\r\n]/g, ' ')))
  .map(([k, v]) => `${k}: ${v}`)
const block = fc.tuple(fc.array(keyLine, { maxLength: 4 }), fc.constantFrom('---', '...'), fc.constantFrom('\n', '\r\n'))
  .map(([lines, close, nl]) => `---${nl}${lines.map(l => `${l}${nl}`).join('')}${close}${nl}`)
/** Text that doesn't start with a block: its first line isn't `---`. */
const text = fc.string({ minLength: 1, maxLength: 200 }).filter(t => !/^\s*---/.test(t) && !/^\uFEFF/.test(t))
const whitespace = fc.constantFrom(' ', '\t', '\r', '\n', '\u00a0', '\u2003', '\u2028', '\u2029', '\u3000', '\ufeff')
const trailingSpace = fc.array(whitespace, { minLength: 1, maxLength: 12 }).map(chs => chs.join(''))
const frontmatterControl = fc.oneof(
  fc.integer({ min: 0, max: 31 }).map(n => String.fromCharCode(n)),
  fc.integer({ min: 127, max: 159 }).map(n => String.fromCharCode(n)),
  fc.constantFrom('\u2028', '\u2029'),
)
const bodyInput = fc.oneof(
  fc.string({ unit: 'binary', maxLength: 200 }),
  fc.tuple(fc.array(block, { maxLength: 3 }), text, trailingSpace).map(([blocks, body, tail]) => blocks.join('') + body + tail),
  fc.tuple(fc.array(block, { minLength: 1, maxLength: 3 }), trailingSpace).map(([blocks, tail]) => blocks.join('').trimEnd() + tail),
)

describe('stripFrontmatter', () => {
  it.prop([fc.array(block, { minLength: 1, maxLength: 3 }), text])('drops every leading block, keeps the text after them, and is steady', (blocks, t) => {
    const stripped = stripFrontmatter(blocks.join('') + t)
    expect(stripped).toBe(stripFrontmatter(t))
    expect(stripFrontmatter(stripped)).toBe(stripped)
    expect(stripped).not.toMatch(/^---/)
  })

  it.prop([text])('text with no leading block loses only its leading blank lines and trailing whitespace', (t) => {
    expect(stripFrontmatter(t)).toBe(t.replace(/^(?:[ \t]*\r?\n)+/, '').trimEnd())
  })

  it.prop([text, fc.array(keyLine, { maxLength: 3 })])('a `---` rule inside the body, or a block that never closes, is text', (t, lines) => {
    const inner = `Intro.\n\n---\n${lines.join('\n')}\n---\n${t}`
    expect(stripFrontmatter(inner)).toBe(inner.trimEnd())
    const unclosed = `---\n${lines.join('\n')}\nno end`
    expect(stripFrontmatter(unclosed)).toBe(unclosed)
  })

  it.prop([fc.array(block, { minLength: 1, maxLength: 3 }), text])('cleanBody makes line ends `\\n` and drops the blocks, whatever their line ends', (blocks, t) => {
    const cleaned = cleanBody(blocks.join('') + t)
    expect(cleaned).not.toMatch(/\r/)
    expect(cleaned).not.toMatch(/^---/)
    expect(cleanBody(cleaned)).toBe(cleaned)
  })

  it.prop([bodyInput])('cleanBody is idempotent even with Unicode whitespace after a closing delimiter', body => {
    expect(cleanBody(cleanBody(body))).toBe(cleanBody(body))
  })
})

/** The frontmatter keys of a SKILL.md as an engine reads them: the first block only, one key per line. */
const keysOf = (file: string): string[] => {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(file)
  if (!m) return []
  return m[1]!.split('\n').map(l => /^([A-Za-z_-]+):/.exec(l)?.[1] ?? `<line: ${l}>`)
}

describe('renderSkillFile', () => {
  const description = fc.string({ minLength: 1, maxLength: 200, unit: 'binary' }).filter(d => brandSkillDescriptionProblem(d) === null)
  const body = fc.tuple(fc.array(block, { maxLength: 2 }), text).map(([b, t]) => cleanBody(b.join('') + t)).filter(b => brandSkillBodyProblem(b) === null)
  it.prop([goodName, description, body])('holds exactly `name` and `description`, the description read back as given, then the body', (name, d, b) => {
    const file = renderSkillFile({ name, description: d, body: b })
    expect(keysOf(file)).toEqual(['name', 'description'])
    expect(JSON.parse(file.split('\n')[2]!.slice('description: '.length))).toBe(d)
    expect(file.endsWith(`\n\n${b}\n`)).toBe(true)
  })

  it.prop([frontmatterControl])('refuses controls in names and descriptions and escapes them even if validation was bypassed', ch => {
    const value = `a${ch}b`
    expect(brandSkillNameProblem(value)).not.toBeNull()
    expect(brandSkillDescriptionProblem(value)).not.toBeNull()
    const file = renderSkillFile({ name: value, description: value, body: 'Steps.' })
    const head = file.split('\n').slice(0, 4)
    expect(file).not.toContain(ch === '\n' ? value : ch)
    expect(JSON.parse(head[1]!.slice('name: '.length))).toBe(value)
    expect(JSON.parse(head[2]!.slice('description: '.length))).toBe(value)
    expect(keysOf(file)).toEqual(['name', 'description'])
  })
})

describe('the name rule', () => {
  it.prop([goodName])('takes lower-case words joined by single hyphens', (n) => {
    expect(brandSkillNameProblem(n)).toBeNull()
  })
  it.prop([fc.string({ maxLength: 70 })])('takes nothing that could be a path, upper case, an edge or doubled hyphen, ours or too long', (n) => {
    const fine = /^[a-z0-9]+(-[a-z0-9]+)*$/.test(n) && n.length <= BRAND_SKILL_NAME_MAX && !RESERVED_SKILL_NAMES.includes(n) && !n.includes('claude') && !n.includes('anthropic')
    expect(brandSkillNameProblem(n) === null).toBe(fine)
  })
  it('refuses these, each with a reason', () => {
    for (const n of ['', '..', 'a/b', 'A', 'a--b', '-a', 'a-', 'a b', 'pdf', 'skill-creator', 'dataviz', 'my-claude', 'anthropic-x', 'a'.repeat(65), 'é']) {
      expect(brandSkillNameProblem(n), n).toMatch(/\w{3}/)
    }
  })
})

describe('the wire (BrandSkillFiles)', () => {
  const nameInput = fc.oneof(goodName.map(n => ` ${n}\t`), fc.string())
  const descriptionInput = fc.oneof(fc.string(), fc.constant('Summarises the returns.'))
  it.prop([nameInput, descriptionInput, bodyInput])('every skill accepted by checkSkill matches BrandSkillFile', (name, description, body) => {
    const checked = checkSkill({ name, description, body })
    if ('ok' in checked) expect(BrandSkillFile.parse(checked.ok)).toEqual(checked.ok)
  })

  const file = (name: string, body = 'Steps.') => ({ name, description: `Does ${name}.`, body })
  it('takes a clean set and refuses a body with frontmatter or a control character, a name twice, or past the byte budget', () => {
    expect(BrandSkillFiles.safeParse([file('a'), file('b')]).success).toBe(true)
    expect(BrandSkillFile.safeParse(file('a', '---\nallowed-tools: Bash\n---\nSteps.')).success).toBe(false)
    expect(BrandSkillFile.safeParse(file('a', 'Steps.\u0007')).success).toBe(false)
    expect(BrandSkillFile.safeParse(file('a', '\nSteps.')).success).toBe(false)
    expect(BrandSkillFiles.safeParse([file('a'), file('a')]).success).toBe(false)
    const big = 'x'.repeat(12_000)
    const many = Array.from({ length: Math.ceil(BRAND_SKILLS_BYTES_MAX / 12_000) + 1 }, (_, i) => file(`s-${i}`, big))
    expect(BrandSkillFiles.safeParse(many).success).toBe(false)
  })
})

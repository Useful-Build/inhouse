// Brand skills (P6a, master plan standing decision 6): skills a brand's people make in a chat, saved by the agent's
// `skill_save` tool to D1 and written by the root runner, at each run's start, into a root-owned plugin beside ours.
// One set of rules for all three places (the tool, the wire and the file), so none of them can disagree:
//  - a name is lower-case letters and digits in hyphen-joined words, 1 to 64 characters, never one of ours and never
//    naming Anthropic or Claude (the engine's own rule for skill names);
//  - a description is one line of plain text, 1 to 1024 characters, with no angle brackets (no XML tags);
//  - a body is the instructions only: any frontmatter it starts with is dropped, so a brand skill can't carry
//    `allowed-tools` or any other key. The file the runner writes has exactly `name` and `description`.
import { z } from 'zod'

export const BRAND_SKILL_NAME_MAX = 64
export const BRAND_SKILL_DESCRIPTION_MAX = 1024
/** About 300 lines of instructions. */
export const BRAND_SKILL_BODY_MAX = 12_000
/** The most skills one brand keeps. */
export const BRAND_SKILLS_MAX = 25
/**
 * The most UTF-8 bytes a brand's skills hold together (names, descriptions and bodies). A run's start carries them all,
 * and with no control character but a newline or tab, JSON writes each at most twice over: 384 KiB at most on the
 * wire, which keeps a start at every field's cap under `RUN_START_MAX_BYTES`. The server refuses a save over it.
 */
export const BRAND_SKILLS_BYTES_MAX = 192 * 1024
/** The engine's plugin name for brand skills: the agent sees each as `brand:<name>`. */
export const BRAND_PLUGIN_NAME = 'brand'

/** Names a brand skill can never take: ours (and the engine's dataviz), so a page or a chat never shows two of one name. */
export const RESERVED_SKILL_NAMES: readonly string[] = ['dataviz', 'pdf', 'word', 'spreadsheet', 'skill-creator']

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
// eslint-disable-next-line no-control-regex
const FRONTMATTER_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/

/** Why a name can't be a brand skill's, in words the agent can pass on; null when it can. */
export function brandSkillNameProblem(name: string): string | null {
  if (name.length === 0 || name.length > BRAND_SKILL_NAME_MAX) return `A skill name is 1 to ${BRAND_SKILL_NAME_MAX} characters.`
  if (FRONTMATTER_CONTROL.test(name) || !NAME.test(name)) return 'A skill name uses lower-case letters and digits, with single hyphens between words (for example "weekly-stock-report").'
  if (name.includes('anthropic') || name.includes('claude')) return 'A skill name can\'t contain "anthropic" or "claude".'
  if (RESERVED_SKILL_NAMES.includes(name)) return `"${name}" is the name of one of the Inhouse team's skills. Pick another name.`
  return null
}

/** Why a description can't be a brand skill's; null when it can. */
export function brandSkillDescriptionProblem(description: string): string | null {
  if (description.length === 0 || description.length > BRAND_SKILL_DESCRIPTION_MAX) return `A skill description is 1 to ${BRAND_SKILL_DESCRIPTION_MAX} characters.`
  if (FRONTMATTER_CONTROL.test(description)) return 'A skill description is one line of plain text.'
  if (/[<>]/.test(description)) return 'A skill description can\'t contain "<" or ">".'
  return null
}

/** A leading frontmatter block: `---` on the first line, then up to the next line that is `---` (or `...`) alone. */
const FRONTMATTER = /^\uFEFF?[ \t]*---[ \t]*\r?\n(?:[^\n]*\n)*?[ \t]*(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/

/**
 * The body without any frontmatter: every leading block is dropped (one can follow another), then the blank lines
 * before the text. Text with no leading block keeps everything but those blank lines and trailing whitespace.
 */
export function stripFrontmatter(text: string): string {
  // Trimming can expose a closing delimiter at EOF, so do it before looking for blocks.
  let out = text.trimEnd()
  for (;;) {
    const lead = out.replace(/^(?:[ \t]*\r?\n)+/, '')
    const m = FRONTMATTER.exec(lead)
    if (!m) return lead
    out = lead.slice(m[0].length)
  }
}

/** A body as it's kept: Windows and old Mac line ends made `\n`, then `stripFrontmatter`. */
export const cleanBody = (text: string): string => stripFrontmatter(text.replace(/\r\n?/g, '\n'))

/** Why a body (already cleaned) can't be a brand skill's; null when it can. */
export function brandSkillBodyProblem(body: string): string | null {
  if (body.trim().length === 0) return 'A skill needs instructions.'
  if (body.length > BRAND_SKILL_BODY_MAX) return `A skill's instructions are at most ${BRAND_SKILL_BODY_MAX} characters. Make them shorter.`
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(body)) return "A skill's instructions are plain text: no control characters but new lines and tabs."
  return null
}

const utf8 = new TextEncoder()
/** What one skill counts against `BRAND_SKILLS_BYTES_MAX`: its name, description and body in UTF-8 (SQLite's `length(CAST(x AS BLOB))`). */
export const brandSkillBytes = (s: { name: string; description: string; body: string }): number =>
  utf8.encode(s.name).length + utf8.encode(s.description).length + utf8.encode(s.body).length

/**
 * The SKILL.md the runner writes: exactly `name` and `description` (the description as a JSON string, which YAML
 * reads as a double-quoted scalar, so nothing in it can start another key), then the body.
 */
export function renderSkillFile(s: { name: string; description: string; body: string }): string {
  // JSON already escapes C0. Escape the remaining controls and Unicode line separators for YAML.
  const quoted = (value: string) => JSON.stringify(value).replace(
    /[\u007f-\u009f\u2028\u2029]/g, ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
  const name = FRONTMATTER_CONTROL.test(s.name) ? quoted(s.name) : s.name
  return `---\nname: ${name}\ndescription: ${quoted(s.description)}\n---\n\n${s.body}\n`
}

/** A brand skill as a run's start carries it. */
export const BrandSkillFile = z.strictObject({
  name: z.string().refine(n => brandSkillNameProblem(n) === null, { message: 'not a brand skill name' }),
  description: z.string().refine(d => brandSkillDescriptionProblem(d) === null, { message: 'not a brand skill description' }),
  body: z.string().refine(b => cleanBody(b) === b && brandSkillBodyProblem(b) === null, { message: 'not a brand skill body' }),
})
export type BrandSkillFile = z.infer<typeof BrandSkillFile>

/** A run's brand skills: at most `BRAND_SKILLS_MAX`, each name once, within `BRAND_SKILLS_BYTES_MAX` together. */
export const BrandSkillFiles = z
  .array(BrandSkillFile)
  .max(BRAND_SKILLS_MAX)
  .refine(a => new Set(a.map(s => s.name)).size === a.length, { message: 'a brand skill named twice' })
  .refine(a => a.reduce((n, s) => n + brandSkillBytes(s), 0) <= BRAND_SKILLS_BYTES_MAX, { message: `brand skills over ${BRAND_SKILLS_BYTES_MAX} bytes` })

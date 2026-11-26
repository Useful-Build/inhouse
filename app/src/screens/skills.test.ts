// A skill's page: its instructions read as a document, and the sample skills that fill it. Ways it could break, written
// down before the code:
//  - the SKILL.md frontmatter (name, description) shows as text or a rule at the top of the instructions;
//  - a `---` further down (a rule) is taken for frontmatter and the text above it disappears;
//  - the page look changes how a chat answer renders (its `##` must stay an h3, its `---` a rule);
//  - a sample skill is missing a section, names a tool the demo doesn't have or a routine that doesn't exist, or two
//    skills share a link (`skillSlugs`), so one page can't be reached;
//  - a team-made skill whose name makes a built-in's slug ("Reorder drafting") opens the built-in one.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeAll, describe, expect, test, vi } from 'vitest'
import fc from 'fast-check'

// The UI store reads the browser at import (window, storage, matchMedia): the smallest stand-ins that let it load under Node.
vi.hoisted(() => {
  const storage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined, clear: () => undefined, key: () => null, length: 0 }
  const g = globalThis as Record<string, unknown>
  g.window = Object.assign(globalThis, { addEventListener: () => undefined, removeEventListener: () => undefined, matchMedia: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }), localStorage: storage, sessionStorage: storage })
})

let Markdown: typeof import('./chat/markdown/renderer').Markdown
let SkillsScreen: typeof import('./Skills')
let store: typeof import('../state/store')
let agentMod: typeof import('../agent')
beforeAll(async () => {
  ;({ Markdown } = await import('./chat/markdown/renderer'))
  SkillsScreen = await import('./Skills')
  store = await import('../state/store')
  agentMod = await import('../agent')
})

const html = (text: string, look?: 'chat' | 'page') => renderToStaticMarkup(createElement(Markdown, { text, look }))
const SKILL_MD = '---\nname: morning-check\ndescription: Reads every tool.\n---\n\n## When to use\n\n- Every weekday.\n\n---\n\n## Steps\n\n1. Read each tool once.\n'

describe('the page look', () => {
  test('strips the frontmatter and nothing else', () => {
    const out = html(SKILL_MD, 'page')
    expect(out).not.toContain('morning-check')
    expect(out).not.toContain('Reads every tool.')
    expect(out).toContain('Every weekday.')
    // The rule between the sections stays a rule.
    expect(out.match(/<hr/g)).toHaveLength(1)
  })
  test('makes ## a section heading (h2): the page has its own h1', () => {
    expect(html(SKILL_MD, 'page').match(/<h2[ >]/g)).toHaveLength(2)
  })
  test("leaves a chat answer as it was: ## is an h3 and a leading --- block isn't stripped", () => {
    const out = html(SKILL_MD)
    // The two sections are h3s. (CommonMark reads the line above the frontmatter's closing --- as a setext heading too, so a chat answer shows that as a heading as well.)
    expect(out).toMatch(/<h3[^>]*>When to use<\/h3>/)
    expect(out).toMatch(/<h3[^>]*>Steps<\/h3>/)
    expect(out).not.toMatch(/<h[12][ >]/)
    expect(out).toContain('Reads every tool.')
    expect(out).toBe(renderToStaticMarkup(createElement(Markdown, { text: SKILL_MD })))
  })
  test('text with no frontmatter keeps every word', () => {
    fc.assert(fc.property(fc.array(fc.stringMatching(/^[a-z]{1,8}$/), { minLength: 1, maxLength: 12 }), words => {
      const text = words.join(' ')
      expect(html(text, 'page')).toContain(text)
    }))
  })
})

describe('the sample skills', () => {
  const SECTIONS = ['When to use', 'What it reads', 'Steps', 'Ground rules', 'What you get']
  test('every one has a full body with the five sections, in order, under its frontmatter, once a skill page loads them', async () => {
    await agentMod.agent.loadSkill('Morning check')
    const { skills } = agentMod.agent.read()
    expect(skills).toHaveLength(9)
    for (const s of skills) {
      expect(s.body, s.n).toMatch(/^---\nname: [a-z-]+\ndescription: .+\n---\n/)
      const heads = [...(s.body ?? '').matchAll(/^## (.+)$/gm)].map(m => m[1])
      expect(heads, s.n).toEqual(SECTIONS)
    }
  })
  test('names only tools and routines the demo has, and each has its own link', () => {
    const data = agentMod.agent.read()
    const toolKeys = new Set([...Object.keys(data.tools.details), ...data.tools.catalog.map(c => c.k)])
    const routineIds = new Set(data.routines.map(r => r.id))
    for (const s of data.skills) {
      expect(s.tools?.length, s.n).toBeGreaterThan(0)
      for (const k of s.tools ?? []) expect(toolKeys.has(k), `${s.n}: ${k}`).toBe(true)
      for (const id of s.routines ?? []) expect(routineIds.has(id), `${s.n}: ${id}`).toBe(true)
      expect(s.updatedAt, s.n).toBeDefined()
      expect(store.skillBySlug(data, { skillsExtra: [] }, store.skillSlug(s.n))?.n).toBe(s.n)
    }
    expect(new Set(data.skills.map(s => store.skillSlug(s.n))).size).toBe(data.skills.length)
  })
  test('a team-made skill named like a built-in gets its own link, the built-in keeps the plain one, and each link opens its own skill', () => {
    const data = agentMod.agent.read()
    const builtIn = data.skills.find(s => s.n === 'Reorder drafting')!
    expect(builtIn).toBeDefined()
    const mine = { ...builtIn, n: 'Reorder  Drafting', mine: true, by: 'You, in a chat' }
    const again = { ...builtIn, n: 'reorder drafting', mine: true, by: 'You, in a chat' }
    const state = { skillsExtra: [mine, again] }
    const slugs = store.skillSlugs(data, state)
    expect(slugs.get(builtIn)).toBe('reorder-drafting')
    expect(slugs.get(mine)).toBe('reorder-drafting-2')
    expect(slugs.get(again)).toBe('reorder-drafting-3')
    for (const [s, slug] of slugs) expect(store.skillBySlug(data, state, slug)).toBe(s)
  })
  test('every skill gets a link no other skill has, whatever the names', () => {
    const data = agentMod.agent.read()
    fc.assert(fc.property(fc.array(fc.constantFrom('Reorder drafting', 'reorder-drafting', 'Reorder drafting 2', '!!', '', 'Morning check', 'x'), { maxLength: 8 }), names => {
      const state = { skillsExtra: names.map(n => ({ ...data.skills[0], n, mine: true })) }
      const slugs = [...store.skillSlugs(data, state).values()]
      expect(new Set(slugs).size).toBe(data.skills.length + names.length)
      for (const [s, slug] of store.skillSlugs(data, state)) expect(store.skillBySlug(data, state, slug)).toBe(s)
    }))
  })
})

describe('a brand skill whose maker had their personal data deleted', () => {
  test('shows "Made by a former member" on the Skills page and skill page, and "Admins" for who can change it', () => {
    const active = { n: 'weekly-report', d: 'Writes it.', icon: 'menu_book', need: 0 as const, by: 'Dana Example', used: '', mine: true, canChange: true }
    const former = { ...active, by: 'a former member', canChange: false }
    expect(SkillsScreen.madeBy(active)).toBe('Made by Dana Example')
    expect(SkillsScreen.madeBy(former)).toBe('Made by a former member')
    expect(SkillsScreen.byline(former)).toBe('Made by a former member in a chat.')
    expect(SkillsScreen.skillFacts(active, false)).toEqual([['Made by', 'Dana Example'], ['Who can change it', 'Dana Example and admins']])
    expect(SkillsScreen.skillFacts(former, false)).toEqual([['Made by', 'a former member'], ['Who can change it', 'Admins']])
    // Demo mock skill with the same "a former member" attribution behaves identically.
    const mockFormer = { ...former, by: 'a former member, in a chat', canChange: true }
    expect(SkillsScreen.madeBy(mockFormer)).toBe('Made by a former member')
    expect(SkillsScreen.byline(mockFormer)).toBe('Made by a former member in a chat.')
    expect(SkillsScreen.skillFacts(mockFormer, true)).toEqual([['Works from', 'Watch'], ['Made by', 'a former member'], ['Who can change it', 'Admins']])
  })
})

describe("a skill's facts in the product (Stage 1 M2-I: no stages)", () => {
  test('the product never says which stage a skill works from, at any need; the demo always does', () => {
    const base = { n: 'reorder', d: 'Drafts it.', icon: 'menu_book', by: 'Inhouse team', used: '' }
    for (const need of [0, 1, 2] as const) {
      expect(SkillsScreen.skillFacts({ ...base, need }, false).map(([k]) => k), `need ${need}`).not.toContain('Works from')
      expect(SkillsScreen.skillFacts({ ...base, need }, true)[0], `need ${need}`).toEqual(['Works from', ['Watch', 'Act', 'Run'][need]])
    }
  })
})

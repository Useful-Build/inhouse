// The Watch switches (P8a S): what a brand at stage Watch may deliver and write. Ways it can fail, written down first:
//  1. at Watch, a notice goes out by any channel but the in-app bell (Slack, email, a channel nobody listed yet);
//  2. at Watch, a write outside Inhouse is allowed;
//  3. a brand whose stage is missing, reset or broken is read as Act or Run instead of Watch (fail open);
//  4. from Act, the bell or a listed channel is refused (the switch is stage-bound, not a blanket off);
//  5. the write switch is a blanket "any write": a tool that writes only Inhouse's own D1 and R2 (memory_save,
//     team_request_create, routines) is refused at Watch, or a hub tool that isn't listed as a read runs.
import { env } from 'cloudflare:workers'
import { fc, it as prop } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import { INHOUSE_TOOLS } from '../mcp/registry.ts'
import { brandStage, deliveryRefusal, externalWriteRefusal, INHOUSE_EXTERNAL_WRITE_TOOLS, toolWriteRefusal, ACT, RUN, WATCH } from './watch.ts'

const db = env.DB
const setStage = async (value: unknown) => {
  await db.prepare("DELETE FROM settings WHERE owner = 'brand' AND key = 'stage'").run()
  if (value === undefined) return
  await db.prepare("INSERT INTO settings (owner, key, value_json, rev, updated_at_ms, updated_by, req_id) VALUES ('brand', 'stage', ?, 1, 0, 'm_x', 'r')")
    .bind(typeof value === 'string' && value.startsWith('raw:') ? value.slice(4) : JSON.stringify(value)).run()
}

describe('brandStage (failure 3)', () => {
  it('reads each stage; missing, reset (null), unknown and unparseable values are Watch', async () => {
    for (const [value, want] of [['Watch', WATCH], ['Act', ACT], ['Run', RUN], [undefined, WATCH], [null, WATCH], ['Later', WATCH], ['raw:{not json', WATCH], [2, WATCH]] as const) {
      await setStage(value)
      expect(await brandStage(db), String(value)).toBe(want)
    }
  })
})

const CHANNEL = fc.oneof(fc.constantFrom('bell', 'slack', 'email', 'sms', 'webhook'), fc.string())

describe('delivery at Watch: the bell only (failure 1, 4)', () => {
  prop.prop([CHANNEL])('at Watch every channel but the bell is refused with `stage`', channel => {
    expect(deliveryRefusal(WATCH, channel)).toBe(channel === 'bell' ? null : 'stage')
  })
  prop.prop([CHANNEL, fc.constantFrom(ACT, RUN)])('from Act no channel is refused by stage (the channel list is its own check)', (channel, stage) => {
    expect(deliveryRefusal(stage, channel)).toBeNull()
  })
  it('a stage index outside 0 to 2 is treated as Watch', () => {
    expect(deliveryRefusal(-1, 'slack')).toBe('stage')
    expect(deliveryRefusal(Number.NaN, 'slack')).toBe('stage')
  })
})

describe('writes outside Inhouse at Watch (failure 2, 4)', () => {
  it('refused at Watch (and at an unknown stage), allowed from Act', () => {
    expect(externalWriteRefusal(WATCH)).toBe('stage')
    expect(externalWriteRefusal(-1)).toBe('stage')
    expect(externalWriteRefusal(Number.NaN)).toBe('stage')
    expect(externalWriteRefusal(ACT)).toBeNull()
    expect(externalWriteRefusal(RUN)).toBeNull()
  })
})

describe('which tools write outside Inhouse (failure 5)', () => {
  const HUB_READS = new Set(['orders_search', 'products_search'])
  it('memory_save, team_request_create and every other inhouse tool run at Watch; a hub write is refused', () => {
    for (const name of ['memory_save', 'memory_update', 'team_request_create', 'team_request_list', 'routine_create']) {
      expect(toolWriteRefusal(WATCH, 'inhouse', name), name).toBeNull()
    }
    for (const t of INHOUSE_TOOLS) expect(toolWriteRefusal(WATCH, 'inhouse', t.name), t.name).toBeNull()
    expect(toolWriteRefusal(WATCH, 'apps', 'orders_search', HUB_READS)).toBeNull()
    for (const write of ['orders_cancel', 'inventory_adjust', 'slack_post_message', 'email_send']) {
      expect(toolWriteRefusal(WATCH, 'apps', write, HUB_READS), write).toBe('stage')
      expect(toolWriteRefusal(ACT, 'apps', write, HUB_READS), write).toBeNull()
    }
  })
  it('the explicit list names only registry tools', () => {
    const names = new Set(INHOUSE_TOOLS.map(t => t.name))
    for (const n of INHOUSE_EXTERNAL_WRITE_TOOLS) expect(names.has(n), n).toBe(true)
  })
})

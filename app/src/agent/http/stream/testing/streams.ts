// Run streams written by hand (streams.json), each with the message list it must render, also written by hand. The
// projection is the oracle: nothing in the data is produced by the reducer or the feed. (W1's recorded streams,
// `server/do/brand-agent/testing/streams`, join these when they land; the same harness reads both.)
// A frame as the socket carries it. Ids are the design's shapes: `r_`/`t_` + 22 base64url characters.
import streams from './streams.json'

export interface Frame { v: number; chatId: string; runId: string; seq: number; at: { iso: string; ms: number }; event: unknown }
/** What the chat shows, per message: its stable id, who wrote it and the words. */
export interface Row { id: string; role: 'user' | 'agent' | 'event'; text: string }
export interface Stream { name: string; runId: string; frames: Frame[]; rows: Row[] }

export const STREAMS: Stream[] = streams as Stream[]

/** Stream 1 with its fifth frame sent under a protocol version this build doesn't accept. */
export const UNSUPPORTED: Stream = { ...STREAMS[0], name: 'a frame of a version nobody here reads', frames: STREAMS[0].frames.map((f, i) => (i === 4 ? { ...f, v: 2 } : f)), rows: [] }

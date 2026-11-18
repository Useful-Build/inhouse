// What a Library file looks like: the type badge, a document's first page, code, a media poster, a sheet.
// Everything is drawn from the file's own data (see LibraryFile in agent/types.ts), so phase 2 only has to fill the same fields.
// Colors in the drawn contents of a thumbnail (paper, poster, waveform) are content art and stay literal. Type chips use the tag tokens.
import type { DocPreview, LibraryFile } from '../../agent'
import { cn } from '@/lib/utils'
import { useCtx } from '../../state/store'
import { Icon } from '../../ui'

const GREY = 'bg-fill text-foreground-2'
const AMBER = 'bg-warning-tint text-warning-text'
const TONE: Record<string, string> = {
  PDF: 'bg-destructive-tint text-destructive-text', MD: 'bg-brand-tint text-brand-text',
  JSON: AMBER, SQL: AMBER, PY: AMBER,
  PNG: GREY, JPG: GREY, ICS: GREY,
  CSV: 'bg-tag-green-tint text-tag-green-text', XLSX: 'bg-tag-green-tint text-tag-green-text',
  M4A: 'bg-tag-violet-tint text-tag-violet-text', MP4: 'bg-tag-teal-tint text-tag-teal-text',
  ZIP: 'bg-tag-brown-tint text-tag-brown-text',
}

export function TypeBadge({ type, size = 40 }: { type: string; size?: number }) {
  return (
    <span aria-hidden="true" className={`inline-flex flex-none items-center justify-center font-mono font-semibold tracking-[0.02em] ${TONE[type] ?? GREY}`}
      style={{ width: size, height: size, borderRadius: size * 0.28, fontSize: size * 0.27 }}>{type}</span>
  )
}

/** A small type chip beside a file name. */
export function TypeChip({ type }: { type: string }) {
  return <span aria-hidden="true" className={`inline-flex h-5 flex-none items-center rounded-sm px-[7px] font-mono text-2xs font-semibold tracking-[0.03em] ${TONE[type] ?? GREY}`}>{type}</span>
}

/** First page of a document Inhouse agent made. Sizes use the page's own width, so it reads the same small or large. */
export function DocPage({ doc }: { doc: DocPreview }) {
  // content art: a white sheet of paper, drawn the same in light and dark
  const brand = useCtx().data.meta.brand.name
  const label = 'font-mono text-[2.3cqw] tracking-[.05em] text-[#6b6b6b] uppercase'
  const total = doc.table?.total
  const col = (i: number) => (i === 0 ? 'flex-3 text-left' : 'flex-1 text-right')
  return (
    <div aria-hidden="true" className="@container relative aspect-[3/4] w-full overflow-hidden bg-[#fff] text-[#171717]">
      <div className="px-[7.5cqw] py-[7cqw] text-[3cqw] leading-[1.4]">
        <div className={label}>{brand} · {doc.tag}</div>
        <div className="mt-[3.2cqw] mb-[4cqw] text-[6.2cqw] leading-[1.12] font-strong tracking-[-0.03em]">{doc.title}</div>
        <div className="grid grid-cols-[auto_1fr] gap-x-[3cqw] gap-y-[.8cqw] text-[#3d3d3d]">
          {doc.meta.map(([k, v]) => <span key={k} className="contents"><span className="text-[#6b6b6b]">{k}</span><span>{v}</span></span>)}
        </div>
        {doc.table && (
          <div className="mt-[4cqw]">
            <div className={`flex gap-[2cqw] border-b border-[#d9d9d9] py-[1.4cqw] text-[2.1cqw] ${label}`}>
              {doc.table.head.map((h, i) => <span key={h} className={col(i)}>{h}</span>)}
            </div>
            {doc.table.rows.map(r => (
              <div key={r[0]} className="flex min-h-[7.6cqw] items-center gap-[2cqw] border-b border-[#ececec]">
                {r.map((c, i) => <span key={i} className={`tabular-nums ${col(i)}`}>{c}</span>)}
              </div>
            ))}
            {total && (
              <div className="flex min-h-[8cqw] items-center gap-[2cqw] font-semibold">
                {(Array.isArray(total) ? total : [total]).map((c, i) => <span key={i} className={`tabular-nums ${col(i)}`}>{c}</span>)}
              </div>
            )}
          </div>
        )}
        {doc.note && <div className="mt-[4cqw] text-[#5c5c5c]">{doc.note}</div>}
      </div>
    </div>
  )
}

/** The start of a text or code file, in a quiet mono block. `lines` cuts it for a card. */
export function CodeBlock({ text, lines, className = '' }: { text: string; lines?: number; className?: string }) {
  const shown = lines ? text.split('\n').slice(0, lines).join('\n') : text
  return (
    <pre className={cn('m-0 overflow-hidden rounded-xl bg-muted px-3.5 py-3 font-mono text-2xs leading-[1.6] wrap-anywhere whitespace-pre-wrap text-foreground-2', className)}>{shown}</pre>
  )
}

/** The same bars every time for one file. */
function bars(id: string, n: number): number[] {
  let x = [...id].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7)
  return Array.from({ length: n }, () => { x = (x * 1664525 + 1013904223) >>> 0; return 0.18 + (x / 4294967296) * 0.82 })
}

const DURATION = 'tabular-nums absolute right-2 bottom-2 inline-flex h-5 items-center rounded-sm bg-overlay px-[7px] text-2xs font-strong text-overlay-foreground'

/** Video: its poster frame with a play button. Audio: a waveform. No real media is loaded. */
export function MediaFace({ file, ratio = '16 / 9', big }: { file: LibraryFile; ratio?: string; big?: boolean }) {
  const play = big ? 64 : 40
  if (file.media === 'video') {
    return (
      // content art: the poster placeholder behind a video frame
      <div className="relative w-full overflow-hidden bg-[#e5e1d8]" style={{ aspectRatio: ratio }}>
        {file.poster && <img src={file.poster} alt="" className="block h-full w-full object-cover" />}
        <span aria-hidden="true" className="absolute top-1/2 left-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-overlay text-overlay-foreground" style={{ width: play, height: play }}>
          <Icon name="play_arrow" size={play * 0.55} fill />
        </span>
        <span className={DURATION}>{file.duration}</span>
      </div>
    )
  }
  const n = big ? 64 : 34
  return (
    // content art: a violet waveform
    <div className={`relative box-border flex w-full items-center justify-center bg-[#f1edf9] px-[14%] ${big ? 'gap-1' : 'gap-[3px]'}`} style={{ aspectRatio: ratio }}>
      {bars(file.id, n).map((h, i) => <i key={i} className={`max-w-[6px] flex-1 rounded-xs ${i < n * 0.34 ? 'bg-[#5b3aa8]' : 'bg-[#c9b9ec]'}`} style={{ height: `${h * (big ? 62 : 56)}%` }} />)}
      <span className={DURATION}>{file.duration}</span>
    </div>
  )
}

/** A table file, as rows. */
export function Sheet({ table }: { table: NonNullable<LibraryFile['table']> }) {
  return (
    <div className="max-w-full overflow-auto rounded-xl border border-border bg-card">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>{table.head.map(h => <th key={h} className="mono-label border-b border-divider bg-muted px-3.5 py-2.5 text-left font-medium whitespace-nowrap">{h}</th>)}</tr>
        </thead>
        <tbody>
          {table.rows.map((r, i) => (
            <tr key={i}>{r.map((c, k) => <td key={k} className="border-b border-divider px-3.5 py-2.25 whitespace-nowrap tabular-nums">{c}</td>)}</tr>
          ))}
        </tbody>
      </table>
      <div className="px-3.5 py-2.25 text-xs text-muted-foreground">{table.total}</div>
    </div>
  )
}

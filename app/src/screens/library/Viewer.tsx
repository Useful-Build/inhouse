// The file viewer: a preview on the left, what it is and where it came from on the right.
import type { ReactNode } from 'react'
import type { LibraryFile, LibraryPlace } from '../../agent'
import { memberFor, userName } from '../../state/derive'
import { fmtTime, fmtWeekday, parseLocal } from '../../agent/clock'
import { useAgentData, useAgentState, useUi } from '../../state/store'
import { Avatar, Button, DetailList, Icon, IconButton, Window } from '../../ui'
import { TAP } from '../../ui/fields'
import { cn } from '@/lib/utils'
import { CodeBlock, DocPage, MediaFace, Sheet } from './Previews'
import { OPEN, openSource } from './source'

const TYPE_LABEL: Record<string, string> = {
  PDF: 'PDF document', CSV: 'CSV spreadsheet', XLSX: 'Excel workbook', MD: 'Markdown note', JSON: 'JSON file', SQL: 'SQL query', PY: 'Python script',
  PNG: 'PNG image', JPG: 'JPG image', M4A: 'Audio recording', MP4: 'Video', ZIP: 'ZIP archive', ICS: 'Calendar file',
}


function Preview({ file, phone }: { file: LibraryFile; phone: boolean }) {
  if (file.src) return <img src={file.src} alt={file.name} className="block max-h-viewer-image w-full rounded-lg object-contain preview-dim" />
  if (file.doc) return <div className={`mx-auto overflow-hidden rounded-sm shadow-float preview-dim ${phone ? 'w-62.5 max-w-full' : 'w-100 max-w-full'}`}><DocPage doc={file.doc} /></div>
  if (file.media) {
    return (
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="preview-dim"><MediaFace file={file} big /></div>
        <div className="flex items-center gap-3 px-3.5 py-2.5">
          <span aria-hidden="true" className="flex size-8 flex-none items-center justify-center rounded-full bg-primary text-primary-foreground"><Icon name="play_arrow" size={19} fill /></span>
          <span className="text-xs text-foreground-3 tabular-nums">0:00 / {file.duration}</span>
          <span aria-hidden="true" className="h-1 flex-1 rounded-2xs bg-fill-hover"><i className="block h-full w-0 rounded-2xs bg-primary" /></span>
          <Icon name="volume_up" size={19} className="text-foreground-3" />
        </div>
      </div>
    )
  }
  if (file.table) return <Sheet table={file.table} />
  if (file.entries) {
    return (
      <ul className="m-0 list-none rounded-xl border border-border bg-card px-3.5 py-1">
        {file.entries.map(e => (
          <li key={e} className="flex min-h-10.75 items-center gap-2.5 border-b border-divider text-sm"><Icon name="description" size={18} className="text-muted-foreground" />{e}</li>
        ))}
      </ul>
    )
  }
  if (file.lines) {
    return (
      <div className="rounded-xl border border-border bg-card px-4 py-1">
        {file.lines.map(([d, t]) => (
          <div key={d} className="flex min-h-11.25 items-center gap-3.5 border-b border-divider text-sm"><b className="w-23 flex-none font-strong">{d}</b><span>{t}</span></div>
        ))}
      </div>
    )
  }
  // A phone scrolls code sideways inside its block, so a line keeps its shape.
  if (file.text) return <CodeBlock text={file.text} className={cn('border border-border bg-card px-4.5 py-4 text-xs', phone && 'overflow-x-auto wrap-normal whitespace-pre')} />
  return null
}


export function Viewer({ file, place, onClose, onLeave, onDownload, onPrev, onNext }: {
  file: LibraryFile; place: LibraryPlace; onClose: () => void; onDownload: () => void
  /** The viewer closes because the person went to where the file came from (the chat, Routines or the approval). */
  onLeave: () => void
  /** The file before and after this one in the Library's current list; missing at either end. */
  onPrev?: () => void; onNext?: () => void
}) {
  const phone = useUi(s => s.phone)
  const data = useAgentData()
  const st = useAgentState()
  const me = userName({ agent: st, data })
  const open = () => { if (!file.link) return; if (openSource(file)) onLeave() }
  const rows: [string, string][] = [
    ['Type', TYPE_LABEL[file.type] ?? file.type], ['Size', file.size], // A details field gives the day too, today's included (a list shows today's as a time only).
    ['Date', `${fmtWeekday(parseLocal(file.at))}, ${fmtTime(parseLocal(file.at))}`],
    [file.madeByAgent ? 'Made by' : 'Uploaded by', file.by],
  ]
  return (
    <Window onClose={onClose} label={`File: ${file.name}`} size="lg">
      <div className="flex items-center gap-2.5 border-b border-divider pt-3.5 pr-3.5 pb-3 pl-5.5">
        {/* The whole name, on as many lines as it needs: a phone has no room for it on one. */}
        <span className="min-w-0 flex-1 text-md font-semibold wrap-anywhere">{file.name}</span>
        <IconButton icon="chevron_left" label="Previous file" disabled={!onPrev} onClick={onPrev} className={cn(phone && TAP)} />
        <IconButton icon="chevron_right" label="Next file" disabled={!onNext} onClick={onNext} className={cn(phone && TAP)} />
        <IconButton icon="close" label="Close" onClick={onClose} className={cn(phone && TAP)} />
      </div>
      <div className={`flex min-h-0 flex-1 overflow-auto ${phone ? 'flex-col' : 'flex-row'}`}>
        <div className={`min-w-0 grow basis-0 bg-muted ${phone ? 'p-4' : 'p-5.5'}`}><Preview file={file} phone={phone} /></div>
        <div className={`box-border flex flex-col gap-4.5 px-5.5 pt-5.5 pb-6 ${phone ? 'flex-none' : 'shrink-0 basis-73'}`}>
          <DetailList strong className="text-sm" items={[
            ...rows.map(([k, v]): [string, ReactNode] => [k, k === 'Uploaded by' ? <span key={k} className="inline-flex items-center gap-1.5">{memberFor(data, v, me) && <Avatar who={v} size={20} fontSize={9} />}{v}</span> : v]),
            ['From', <span key="from">
              <span className="inline-flex items-center gap-1.5"><Icon name={place.icon} size={15} />{file.link ? file.from : place.name}</span>
              {file.link && <div><Button variant="link" className="mt-1.5 text-sm" onClick={open}>{OPEN[file.link.to]} →</Button></div>}
            </span>],
          ]} />
          <Button size="lg" onClick={onDownload}><Icon name="download" size={18} />Download</Button>
        </div>
      </div>
    </Window>
  )
}

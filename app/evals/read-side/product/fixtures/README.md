# Read-side file reader fixtures

Probe and honest files for `../extract.ts`, from the #340 review rounds. `extract.fixtures.test.ts` names what each must read as.

- `pdf/01-*` to `pdf/19-*`: hostile PDF probes (`gen/pdfprobes.py`, `gen/pdfprobes2.py`); 18 and 19 are honest controls. `pdf/A-*` to `pdf/D-*`: round 4's probes (`gen/pdfprobes3.py`, `gen/pdfprobes4.py`: a hybrid /XRefStm, an object redefined by an update, an indirect URL file spec, a duplicate object the xref points at first). `pdf/E-*` to `pdf/H-*`: round 5's (`gen/pdfprobes5.py`: an object stream index mismatch, a number at top level and in an object stream, a generation reuse, an /XRefStm into an image).
- `pdf/rl-*`, `pdf/nc-*`: honest reportlab output (`gen/honest.py`, `gen/nocomp.py`; `rl-title-*` are the same canvas with a title).
- `office/pd.docx`, `office/ox.xlsx`: honest python-docx and openpyxl output (`gen/honest.py`); `office/d*`, `office/x*` are probes made from them (`gen/ooxprobes.py`).

Invented content only; hosts are `example.com` and `evil.example`.

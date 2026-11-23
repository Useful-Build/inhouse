import struct, os, zlib
import sys; OUT = sys.argv[1]
def w(n,b): open(os.path.join(OUT,n),'wb').write(b)
def stream(d,data): return b'<< '+d+b' /Length %d >>\nstream\n'%len(data)+data+b'\nendstream'
def img(data): return stream(b'/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8', data)
CAT=b'<< /Type /Catalog /Pages 2 0 R >>'
PAGES=b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>'
PAGE=b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 5 0 R >>'
CONTENT=stream(b'', b'BT ET')
def classic(out, ent, size, trailer):
    x=len(out); out=bytearray(out)
    out+=b'xref\n0 1\n0000000000 65535 f \n'
    for n in sorted(ent):
        off=ent[n]; out+=b'%d 1\n%010d 00000 n \n'%(n,off)
    out+=b'trailer\n'+trailer+b'\nstartxref\n%d\n%%%%EOF\n'%x
    return bytes(out)

# PROBE A: hybrid-reference. Classic xref is complete & valid for objs 1-5. A hidden object (unsafe /URI link) lives INSIDE
# object 4's image stream bytes; the trailer carries /XRefStm pointing at a hidden xref stream (also inside the image bytes)
# that lists the hidden object. A hybrid-aware viewer (pdf.js, Acrobat) merges it; the grader parser should not see it.
def probeA():
    def build(hidden):
        out=bytearray(b'%PDF-1.5\n%\xe2\xe3\xcf\xd3\n'); offs={}
        for num,body in [(1,b'<< /Type /Catalog /Pages 2 0 R /Names 9 0 R >>'),(2,PAGES),(3,PAGE),(4,img(hidden)),(5,CONTENT)]:
            offs[num]=len(out); out+=b'%d 0 obj\n'%num+body+b'\nendobj\n'
        return bytes(out),offs
    h=b'X'
    for _ in range(6):
        out,offs=build(h)
        ds=out.index(b'stream\n',offs[4])+7
        hh=bytearray(b'\n')
        o9=ds+len(hh); hh+=b'9 0 obj\n<< /S /URI /URI (https://evil.example/exfil) >>\nendobj\n'
        rows=struct.pack('>BIB',1,o9,0)
        o10=ds+len(hh); hh+=b'10 0 obj\n'+stream(b'/Type /XRef /Size 11 /Index [9 1] /W [1 4 1]',rows)+b'\nendobj\n'
        h=bytes(hh)
    out,offs=build(h)
    assert out.index(b'stream\n',offs[4])+7==ds
    w('A-hybrid-xrefstm.pdf', classic(out,{1:offs[1],2:offs[2],3:offs[3],4:offs[4],5:offs[5]},11,
        b'<< /Size 11 /Root 1 0 R /XRefStm %d >>'%o10))

# PROBE B: object reused across incremental update. Base defines obj 6 = unsafe URI annot target; the update redefines obj 6
# as a safe URI. A viewer uses the LAST definition (safe); the parser walks EVERY version, so it should see the unsafe one too
# (parser safer than viewer -> no bypass, expected). Included to confirm direction.
def probeB():
    annot=b'<< /Type /Annot /Subtype /Link /Rect [0 0 200 200] /A << /S /URI /URI 6 0 R >> >>'
    page=b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 5 0 R /Annots [7 0 R] >>'
    out=bytearray(b'%PDF-1.5\n%\xe2\xe3\xcf\xd3\n'); offs={}
    for num,body in [(1,CAT),(2,PAGES),(3,page),(5,CONTENT),(6,b'(https://evil.example/old)'),(7,annot)]:
        offs[num]=len(out); out+=b'%d 0 obj\n'%num+body+b'\nendobj\n'
    b1=bytearray(classic(bytes(out),offs,8,b'<< /Size 8 /Root 1 0 R >>'))
    x1=int(b1.rsplit(b'startxref\n',1)[1].split(b'\n')[0])
    o6b=len(b1); b1+=b'6 0 obj\n(https://pages.example/RS-WW1)\nendobj\n'
    w('B-incremental-reuse.pdf', classic(bytes(b1),{6:o6b},8,b'<< /Size 8 /Root 1 0 R /Prev %d >>'%x1))

# PROBE C: indirect URL file specification (/FS indirect).
def probeC():
    page=b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 5 0 R /Annots [6 0 R] >>'
    annot=b'<< /Type /Annot /Subtype /Link /Rect [0 0 1 1] /A << /S /GoToR /D [0 /Fit] /F << /FS 8 0 R /F (https://evil.example/t.pdf) >> >> >>'
    out=bytearray(b'%PDF-1.5\n%\xe2\xe3\xcf\xd3\n'); offs={}
    for num,body in [(1,CAT),(2,PAGES),(3,page),(5,CONTENT),(6,annot),(8,b'/URL')]:
        offs[num]=len(out); out+=b'%d 0 obj\n'%num+body+b'\nendobj\n'
    w('C-indirect-fs-url.pdf', classic(bytes(out),offs,9,b'<< /Size 9 /Root 1 0 R >>'))

for f in (probeA,probeB,probeC): f()
print('generated')

import os
import sys; OUT = sys.argv[1]
def w(n,b): open(os.path.join(OUT,n),'wb').write(b)
def stream(d,data): return b'<< '+d+b' /Length %d >>\nstream\n'%len(data)+data+b'\nendstream'
CONTENT=stream(b'', b'BT ET')
CAT=b'<< /Type /Catalog /Pages 2 0 R >>'
PAGES=b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>'

# D: object 6 defined TWICE in one body (v1 unsafe URI first, v2 safe URI second). A single classic xref points obj 6 at v1's
# offset. A viewer locates obj 6 via xref -> v1 (unsafe). The parser scans sequentially and resolves /URI 6 0 R to the LAST
# write -> v2 (safe). Divergence -> grader reads safe, viewer reaches evil.example.
def probeD():
    page=b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 5 0 R /Annots [7 0 R] >>'
    annot=b'<< /Type /Annot /Subtype /Link /Rect [0 0 200 200] /A << /S /URI /URI 6 0 R >> >>'
    out=bytearray(b'%PDF-1.5\n%\xe2\xe3\xcf\xd3\n'); off={}
    def put(num,body,tag=None):
        off[tag or num]=len(out)
        out.extend(b'%d 0 obj\n'%num+body+b'\nendobj\n')
    put(1,CAT); put(2,PAGES); put(3,page); put(5,CONTENT)
    put(6,b'(https://evil.example/steal)',tag='6v1')
    put(6,b'(https://pages.example/RS-WW1)',tag='6v2')
    put(7,annot)
    x=len(out)
    ent={1:off[1],2:off[2],3:off[3],5:off[5],6:off['6v1'],7:off[7]}  # obj6 -> v1 (unsafe)
    out.extend(b'xref\n0 1\n0000000000 65535 f \n')
    for n in sorted(ent): out.extend(b'%d 1\n%010d 00000 n \n'%(n,ent[n]))
    out.extend(b'trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n'%x)
    w('D-dup-xref-points-first.pdf', bytes(out))
probeD(); print('ok')

import os, sys, struct, zlib
OUT=sys.argv[1]
def w(n,b): open(os.path.join(OUT,n),'wb').write(b)
def stream(d,data): return b'<< '+d+b' /Length %d >>\nstream\n'%len(data)+data+b'\nendstream'
CAT=b'<< /Type /Catalog /Pages 2 0 R >>'
PAGES=b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>'
PAGE=b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 5 0 R /Annots [7 0 R] >>'
ANNOT=b'<< /Type /Annot /Subtype /Link /Rect [0 0 200 200] /A << /S /URI /URI 6 0 R >> >>'
CONTENT=stream(b'',b'BT ET')
def objstm(objs):
    hdr=b''; body=b''
    for n,v in objs: hdr+=b'%d %d '%(n,len(body)); body+=v+b'\n'
    return stream(b'/Type /ObjStm /N %d /First %d'%(len(objs),len(hdr)), hdr+body)
def xrefstm_file(top, entries_fn, name, extra_tail=b''):
    out=bytearray(b'%PDF-1.5\n%\xe2\xe3\xcf\xd3\n'); off={}
    for n,body in top:
        off[n]=len(out); out+=b'%d 0 obj\n'%n+body+b'\nendobj\n'
    xn=max(off)+1; x=len(out)
    ents=entries_fn(off, xn, x)  # dict num->(t,f1,f2)
    size=max(ents)+1
    rows=b''.join(struct.pack('>BIH',*ents.get(i,(0,0,0))) for i in range(size))
    out+=b'%d 0 obj\n'%xn+stream(b'/Type /XRef /Size %d /W [1 4 2] /Root 1 0 R'%size, rows)+b'\nendobj\n'
    out+=b'startxref\n%d\n%%%%EOF\n'%x
    w(name, bytes(out))
# E: ObjStm 10 holds obj 6 (safe) at index 0 and obj 9 (unsafe) at index 1; xref says obj 6 -> (10, index 1).
def E():
    top=[(1,CAT),(2,PAGES),(3,PAGE),(5,CONTENT),(7,ANNOT),(10,objstm([(6,b'(https://pages.example/RS-WW1)'),(9,b'(https://evil.example/idx)')]))]
    def ents(off,xn,x):
        e={n:(1,o,0) for n,o in off.items()}; e[6]=(2,10,1); e[9]=(2,10,1); e[xn]=(1,x,0); return e
    xrefstm_file(top,ents,'E-objstm-index-mismatch.pdf')
# F: same number at top level and in an ObjStm.
def F():
    top=[(1,CAT),(2,PAGES),(3,PAGE),(5,CONTENT),(6,b'(https://evil.example/f)'),(7,ANNOT),(10,objstm([(6,b'(https://pages.example/RS-WW1)')]))]
    def ents(off,xn,x):
        e={n:(1,o,0) for n,o in off.items()}; e[xn]=(1,x,0); return e
    xrefstm_file(top,ents,'F-top-and-objstm.pdf')
# G: obj 6 gen 0 and obj 6 gen 1, classic xref -> gen1 copy.
def G():
    out=bytearray(b'%PDF-1.5\n'); off={}
    ann=ANNOT.replace(b'6 0 R',b'6 1 R')
    for n,g,body in [(1,0,CAT),(2,0,PAGES),(3,0,PAGE),(5,0,CONTENT),(6,0,b'(https://pages.example/RS-WW1)'),(6,1,b'(https://evil.example/g)'),(7,0,ann)]:
        off[(n,g)]=len(out); out+=b'%d %d obj\n'%(n,g)+body+b'\nendobj\n'
    x=len(out); out+=b'xref\n0 1\n0000000000 65535 f \n'
    for (n,g),o in sorted(off.items()):
        if (n,g)==(6,0): continue
        out+=b'%d 1\n%010d %05d n \n'%(n,o,g)
    out+=b'trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n'%x
    w('G-gen1-reuse.pdf',bytes(out))
# H: hybrid; /XRefStm -> a top-level xref stream (parsed) whose type-1 entry for obj 9 points inside an image stream.
def H():
    out=bytearray(b'%PDF-1.5\n'); off={}
    hidden=b'\n9 0 obj\n(https://evil.example/h)\nendobj\n'
    img=stream(b'/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8',hidden)
    for n,body in [(1,CAT),(2,PAGES),(3,PAGE.replace(b' /Annots [7 0 R]',b'')),(4,img),(5,CONTENT)]:
        off[n]=len(out); out+=b'%d 0 obj\n'%n+body+b'\nendobj\n'
    o9=out.index(b'9 0 obj')
    xs=len(out); rows=struct.pack('>BIH',1,o9,0)
    out+=b'10 0 obj\n'+stream(b'/Type /XRef /Size 11 /Index [9 1] /W [1 4 2]',rows)+b'\nendobj\n'
    x=len(out); out+=b'xref\n0 1\n0000000000 65535 f \n'
    for n in sorted(off): out+=b'%d 1\n%010d 00000 n \n'%(n,off[n])
    out+=b'trailer\n<< /Size 11 /Root 1 0 R /XRefStm %d >>\nstartxref\n%d\n%%%%EOF\n'%(xs,x)
    w('H-xrefstm-into-image.pdf',bytes(out))
for f in (E,F,G,H): f()

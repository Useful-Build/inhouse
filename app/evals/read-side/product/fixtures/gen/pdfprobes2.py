import sys, zlib, struct
sys.path.insert(0, sys.argv[2]); from pdfprobes import JS, PAGES, PAGE, stream, png_predict, build
out=sys.argv[1]
def w(name, data): open(f"{out}/{name}.pdf", "wb").write(data)
hidden = b"6\x000\x00obj " + JS + b"\n"
# NUL-separated header variants of 03 and 16
w("03b-hide-after-zlib-nul", build([(1, b"<< /Type /Catalog /Pages 2 0 R >>"), (5, stream(b"/Filter /FlateDecode", zlib.compress(b"BT ET") + b"\n" + hidden)), (2,PAGES),(3,PAGE)], root=6, extra_offsets={6: (b"6\x000", 5)}))
w("16b-hide-in-xrefstream-nul", build([(1, b"<< /Type /Catalog /Pages 2 0 R >>"), (5, stream(b"/Type /XRef /Size 1 /W [1 2 1]", b"\x00\x00\x00\x00" + hidden)), (2,PAGES),(3,PAGE)], root=6, extra_offsets={6: (b"6\x000", 5)}))
# ObjStm files with a real xref stream: object 1 (catalog) lives in object stream 7
os_body = b"1 0 " + JS
def objstm_pdf(osdict, osdata):
    b = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n"); offs={}
    for num, body in [(2,PAGES),(3,PAGE),(7, b"<< " + osdict + b" /Length %d >>\nstream\n" % len(osdata) + osdata + b"\nendstream")]:
        offs[num]=len(b); b += b"%d 0 obj\n" % num + body + b"\nendobj\n"
    offs[8]=len(b)
    rows=[b"\x00\x00\x00\xff\xff", b"\x02\x00\x00\x07\x00", b"\x01"+struct.pack(">I",offs[2])[1:]+b"\x00", b"\x01"+struct.pack(">I",offs[3])[1:]+b"\x00",
          b"\x00\x00\x00\x00\x00", b"\x00\x00\x00\x00\x00", b"\x00\x00\x00\x00\x00", b"\x01"+struct.pack(">I",offs[7])[1:]+b"\x00", b"\x01"+struct.pack(">I",offs[8])[1:]+b"\x00"]
    data=zlib.compress(b"".join(rows))
    b += b"8 0 obj\n<< /Type /XRef /Size 9 /W [1 3 1] /Root 1 0 R /Filter /FlateDecode /Length %d >>\nstream\n" % len(data) + data + b"\nendstream\nendobj\nstartxref\n%d\n%%%%EOF\n" % offs[8]
    return bytes(b)
w("04b-objstm-untyped-length1", objstm_pdf(b"/N 1 /First 4 /Length1 10 /Filter /FlateDecode", zlib.compress(os_body)))
w("05b-objstm-typed", objstm_pdf(b"/Type /ObjStm /N 1 /First 4 /Filter /FlateDecode", zlib.compress(os_body)))
w("04c-objstm-untyped-metadata", objstm_pdf(b"/Type /Metadata /N 1 /First 4 /Filter /FlateDecode", zlib.compress(os_body)))
pred=png_predict(os_body, 4)
w("07b-objstm-predictor", objstm_pdf(b"/Type /ObjStm /N 1 /First 4 /Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 4 >>", zlib.compress(pred)))

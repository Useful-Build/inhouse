import sys, zipfile, re
src, out = sys.argv[1], sys.argv[2]
def variant(base, name, edit, add=None, drop=()):
    zin = zipfile.ZipFile(base); zo = zipfile.ZipFile(f"{out}/{name}", "w", zipfile.ZIP_DEFLATED)
    for i in zin.infolist():
        if i.filename in drop: continue
        d = zin.read(i.filename)
        d = edit(i.filename, d) if edit else d
        zo.writestr(i.filename, d)
    for k, v in (add or {}).items(): zo.writestr(k, v)
    zo.close()
D = f"{src}/pd.docx"; X = f"{src}/ox.xlsx"
W = b'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
fld = b'<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> INCLUDEPICTURE "https://evil.example/p.png" \\d </w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'
def ins(x): return lambda n, d: d.replace(b'<w:sectPr', x + b'<w:sectPr', 1) if n == 'word/document.xml' else d
variant(D, "d01-field-control.docx", ins(fld))
# same field with a different prefix bound to the same namespace
pfx = fld.replace(b'w:', b'q:').replace(b'<q:p>', b'<q:p xmlns:q="' + W + b'">', 1)
variant(D, "d02-field-prefix-q.docx", ins(pfx))
variant(D, "d03-fldsimple-singlequote.docx", ins(b"<w:p><w:fldSimple w:instr='INCLUDEPICTURE \"https://evil.example/p.png\" \\d'><w:r><w:t>x</w:t></w:r></w:fldSimple></w:p>"))
variant(D, "d04-fldsimple-prefix.docx", ins(b'<w:p><z:fldSimple xmlns:z="' + W + b'" z:instr="INCLUDETEXT &quot;https://evil.example/t&quot;"><w:r><w:t>x</w:t></w:r></z:fldSimple></w:p>'))
# customXml part carrying a URL
variant(D, "d05-customxml-url.docx", None, add={"customXml/item9.xml": b'<?xml version="1.0"?><root><u>https://evil.example/c</u></root>'})
# embedded font (obfuscated .odttf), image outside media/
variant(D, "d06-embedded-font.docx", None, add={"word/fonts/font1.odttf": b"\x00\x01\x00\x00junk"})
variant(D, "d07-image-not-media.docx", None, add={"word/pics/image9.png": b"\x89PNG\r\n\x1a\n"})
# VML image with a remote src (no relationship)
variant(D, "d08-vml-remote-src.docx", ins(b'<w:p><w:r><w:pict><v:shape xmlns:v="urn:schemas-microsoft-com:vml" style="width:10pt;height:10pt"><v:imagedata src="https://evil.example/v.png"/></v:shape></w:pict></w:r></w:p>'))
# xlsx
def xins(x): return lambda n, d: d.replace(b'</sheetData>', x + b'</sheetData>', 1) if n == 'xl/worksheets/sheet1.xml' else d
variant(X, "x01-formula-control.xlsx", xins(b'<row r="9"><c r="A9"><f>WEBSERVICE("https://evil.example/w")</f></c></row>'))
variant(X, "x02-formula-prefix.xlsx", xins(b'<row r="9"><c r="A9"><zz:f xmlns:zz="http://schemas.openxmlformats.org/spreadsheetml/2006/main">WEBSERVICE("https://evil.example/w")</zz:f></c></row>'))
pivot = b'<?xml version="1.0"?><pivotCacheDefinition xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId1"><cacheSource type="worksheet"><worksheetSource ref="A1:B9" sheet="Data" r:id="rId1"/></cacheSource><cacheFields count="0"/></pivotCacheDefinition>'
prel = b'<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLinkPath" Target="https://evil.example/book.xlsx" TargetMode="External"/></Relationships>'
variant(X, "x03-pivot-external.xlsx", None, add={"xl/pivotCache/pivotCacheDefinition1.xml": pivot, "xl/pivotCache/_rels/pivotCacheDefinition1.xml.rels": prel})
variant(X, "x04-calc-column-formula.xlsx", None, add={"xl/tables/table9.xml": b'<?xml version="1.0"?><table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="9" name="T9" displayName="T9" ref="A1:B2"><tableColumns count="2"><tableColumn id="1" name="a"/><tableColumn id="2" name="b"><calculatedColumnFormula>WEBSERVICE("https://evil.example/t")</calculatedColumnFormula></tableColumn></tableColumns></table>'})
variant(X, "x05-printer-settings.xlsx", None, add={"xl/printerSettings/printerSettings1.bin": b"\x00\x01"})
variant(X, "x06-pivot-calcfield-attr.xlsx", None, add={"xl/pivotCache/pivotCacheDefinition2.xml": b'<?xml version="1.0"?><pivotCacheDefinition xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cacheFields><cacheField name="c" formula="WEBSERVICE(&quot;https://evil.example/p&quot;)"/></cacheFields></pivotCacheDefinition>'})

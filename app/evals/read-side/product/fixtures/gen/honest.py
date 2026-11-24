import sys, os
out = sys.argv[1]
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4
from reportlab.platypus import SimpleDocTemplate, Paragraph, Table, Image as RLImage
from reportlab.lib.styles import getSampleStyleSheet
c = canvas.Canvas(f"{out}/rl-canvas.pdf"); c.drawString(100,750,"Refund report: live stream upstream (x)"); c.linkURL("https://example.com/a",(100,700,200,720)); c.showPage(); c.save()
c = canvas.Canvas(f"{out}/rl-canvas-nocomp.pdf", pageCompression=0); c.drawString(100,750,"Mainstream stream report"); c.bookmarkPage("p1"); c.addOutlineEntry("Intro","p1"); c.showOutline(); c.showPage(); c.save()
# png image
import zlib, struct
def png(w,h):
    raw=b''.join(b'\x00'+bytes([(x*7+y*3)%256 for x in range(w*3)]) for y in range(h))
    def ch(t,d): return struct.pack('>I',len(d))+t+d+struct.pack('>I',zlib.crc32(t+d)&0xffffffff)
    return b'\x89PNG\r\n\x1a\n'+ch(b'IHDR',struct.pack('>IIBBBBB',w,h,8,2,0,0,0))+ch(b'IDAT',zlib.compress(raw))+ch(b'IEND',b'')
open(f"{out}/img.png","wb").write(png(64,64))
ss=getSampleStyleSheet()
doc=SimpleDocTemplate(f"{out}/rl-platypus.pdf", title="Q3 refunds", author="Ops")
doc.build([Paragraph('Hello <a href="https://example.com/x">link</a> (paren) \\ back',ss['Normal']), Table([["a","b"],["1","2"]]), RLImage(f"{out}/img.png",50,50)])
# TTF embedded if available
try:
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    for p in ["/System/Library/Fonts/Supplemental/Arial.ttf","/Library/Fonts/Arial Unicode.ttf"]:
        if os.path.exists(p):
            pdfmetrics.registerFont(TTFont("Ar",p)); c=canvas.Canvas(f"{out}/rl-ttf.pdf"); c.setFont("Ar",12); c.drawString(100,700,"Ünïcode €"); c.save(); break
except Exception as e: print("ttf", e)
# acroform
c=canvas.Canvas(f"{out}/rl-form.pdf"); c.acroForm.textfield(name="n",x=100,y=600); c.acroForm.checkbox(name="c",x=100,y=500); c.showPage(); c.save()
import docx
d=docx.Document(); d.add_heading("Report",0); d.add_paragraph("Body text https://example.com/plain"); d.add_picture(f"{out}/img.png"); t=d.add_table(rows=2,cols=2); d.sections[0].header.paragraphs[0].text="Header"; d.save(f"{out}/pd.docx")
import openpyxl
from openpyxl.drawing.image import Image as XImg
from openpyxl.chart import BarChart, Reference
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.workbook.defined_name import DefinedName
wb=openpyxl.Workbook(); ws=wb.active; ws.append(["a",1]); ws.append(["b",2]); ws["C1"]="=SUM(B1:B2)"; ws["D1"].hyperlink="https://example.com/x"
ws.add_image(XImg(f"{out}/img.png"),"F2"); ch=BarChart(); ch.add_data(Reference(ws,min_col=2,min_row=1,max_row=2)); ws.add_chart(ch,"H2")
dv=DataValidation(type="list",formula1='"x,y"'); ws.add_data_validation(dv); dv.add("E1")
wb.defined_names["tot"]=DefinedName("tot",attr_text="Sheet!$B$1:$B$2")
ws.add_table(openpyxl.worksheet.table.Table(displayName="T1",ref="A1:B2")) if False else None
ws2=wb.create_sheet("S2"); ws2["A1"]="x"
wb.save(f"{out}/ox.xlsx")

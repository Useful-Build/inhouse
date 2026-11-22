import sys
from reportlab.pdfgen import canvas
out=sys.argv[1]
for name,txt in [("nc-plain","Quarterly refunds"),("nc-stream","Live stream schedule"),("nc-paren","Totals (net"),("nc-slash","Ratio 1/2 and a/#b")]:
    c=canvas.Canvas(f"{out}/{name}.pdf",pageCompression=0); c.drawString(100,750,txt); c.showPage(); c.save()

const units = "kg|kgs?|gm|g|ml|l|ltr|litre|litres|pcs?|piece|packet|pkt|box|bottles?";

async function loadPdfJs() {
  if (window.pdfjsLib) return window.pdfjsLib;
  await new Promise((resolve, reject) => { const script=document.createElement("script"); script.src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"; script.onload=resolve; script.onerror=reject; document.head.appendChild(script); });
  return window.pdfjsLib;
}
function normalizeUnit(raw) { const unit=String(raw||"pcs").toLowerCase(); if (["g","gm"].includes(unit)) return "kg"; if (["ml"].includes(unit)) return "litre"; if (["l","ltr","litre","litres"].includes(unit)) return "litre"; if (["bottle","bottles"].includes(unit)) return "bottle"; return ["kg","packet","box"].includes(unit) ? unit : "pcs"; }
function isoDate(value="") { const match=String(value).match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b/); if(!match)return ""; const [,day,month,year]=match,fullYear=year.length===2?`20${year}`:year; return `${fullYear}-${month.padStart(2,"0")}-${day.padStart(2,"0")}`; }

export async function extractTextFromPdf(file) {
  if (file?.type !== "application/pdf") throw new Error("File is not a PDF.");
  const pdfjs=await loadPdfJs(); pdfjs.GlobalWorkerOptions.workerSrc="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  const pdf=await pdfjs.getDocument({data:await file.arrayBuffer()}).promise, pages=[];
  for(let pageNo=1;pageNo<=pdf.numPages;pageNo++) { const page=await pdf.getPage(pageNo), content=await page.getTextContent(), rows=new Map(); content.items.forEach(item=>{const y=Math.round(Number(item.transform?.[5]||0)/3)*3,row=rows.get(y)||[];row.push({x:Number(item.transform?.[4]||0),text:item.str||""});rows.set(y,row);}); pages.push([...rows.entries()].sort((a,b)=>b[0]-a[0]).map(([,row])=>row.sort((a,b)=>a.x-b.x).map(cell=>cell.text).join(" ")).join("\n")); }
  return pages.join("\n\n").trim();
}

export async function renderPdfFirstPage(file) {
  const pdfjs=await loadPdfJs(); pdfjs.GlobalWorkerOptions.workerSrc="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  const pdf=await pdfjs.getDocument({data:await file.arrayBuffer()}).promise, page=await pdf.getPage(1), viewport=page.getViewport({scale:2});
  const canvas=document.createElement("canvas"); canvas.width=Math.ceil(viewport.width); canvas.height=Math.ceil(viewport.height); await page.render({canvasContext:canvas.getContext("2d"),viewport}).promise;
  const blob=await new Promise(resolve=>canvas.toBlob(resolve,"image/jpeg",.92)); if(!blob)throw new Error("PDF has no readable text and first-page conversion is unavailable."); return new File([blob],file.name.replace(/\.pdf$/i,".jpg"),{type:"image/jpeg"});
}

export async function extractTextFromImageWithOcr(file, requestOcr) { if(typeof requestOcr!=="function") throw new Error("Secure OCR request is unavailable."); return requestOcr(file); }

export function validateBillItem(row) { return Boolean(/[A-Za-z]/.test(String(row?.itemName||"")) && Number(row?.quantity)>0 && Number.isFinite(Number(row?.unitPrice)) && Number.isFinite(Number(row?.totalPrice))); }
export function normalizeBillRows(rows=[]) { return rows.filter(Boolean).map(row=>({itemName:String(row.itemName||"").replace(/^\d+\s+(?:[.)-]\s*)?/,"").trim(),quantity:Number(row.quantity||0),unit:normalizeUnit(row.unit),unitPrice:Number(row.unitPrice||row.rate||0),totalPrice:Number(row.totalPrice||row.amount||0),category:String(row.category||"")})).filter(validateBillItem); }
export function parseSupplierBillText(text="") { const lines=String(text).split(/\r?\n/).map(line=>line.replace(/[|]/g," ").replace(/\s+/g," ").trim()).filter(Boolean), supplierName=lines.find(line=>!/^(tax invoice|invoice|bill|gstin|phone|mobile|address)/i.test(line))||lines[0]||"", billNumber=(text.match(/(?:invoice|bill)\s*(?:no\.?|number|#)\s*[:#-]?\s*([a-z0-9/-]+)/i)||[])[1]||"", date=isoDate((text.match(/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/)||[])[0]), taxAmount=Number((text.match(/(?:gst|tax|cgst|sgst|igst)\D{0,12}(\d+(?:\.\d{1,2})?)/i)||[])[1]||0), grandTotal=Number((text.match(/\b(?:grand\s*total|net\s*amount|total)\b\D{0,12}(\d+(?:\.\d{1,2})?)/i)||[])[1]||0);
  const items=normalizeBillRows(lines.map(raw=>{const line=raw.replace(/^\d+\s+(?:[.)-]\s*)?(?=[A-Za-z])/,""),match=line.match(new RegExp(`^(.+?)\\s+(\\d+(?:\\.\\d+)?)\\s*(${units})?\\s+(?:@\\s*)?(\\d+(?:\\.\\d{1,2})?)\\s+(\\d+(?:\\.\\d{1,2})?)$`,"i"));return match?{itemName:match[1],quantity:match[2],unit:match[3],unitPrice:match[4],totalPrice:match[5]}:null;}));
  return {supplierName,billNumber,billNo:billNumber,billDate:date,date,taxAmount,grandTotal,total:grandTotal,items,rawText:String(text),parseWarnings:items.length?[]:["Text was extracted, but no bill item rows matched. Edit the text, try parsing again, or enter rows manually."]};
}

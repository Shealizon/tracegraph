import * as pdfjs from 'pdfjs-dist/build/pdf.mjs';
import workerSrc from 'pdfjs-dist/build/pdf.worker.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

export async function extractPdfText(file, { maxPages = 80 } = {}) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({ data: bytes }).promise;
  const pages = [];
  const count = Math.min(doc.numPages, Math.max(1, maxPages));
  for (let pageNumber = 1; pageNumber <= count; pageNumber += 1) {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = content.items.map((item) => item.str).join(' ').replace(/\s+/g, ' ').trim();
    pages.push({ page: pageNumber, text });
  }
  return { pageCount: doc.numPages, truncated: count < doc.numPages, pages };
}

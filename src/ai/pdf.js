import * as pdfjs from 'pdfjs-dist/build/pdf.mjs';
import PdfWorker from 'pdfjs-dist/build/pdf.worker.mjs?worker';

pdfjs.GlobalWorkerOptions.workerPort = new PdfWorker();

export async function openPdfDocument(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return pdfjs.getDocument({ data: bytes }).promise;
}

export function createPdfTextLayer(options) {
  return new pdfjs.TextLayer(options);
}

export async function extractPdfText(file, { maxPages = 80 } = {}) {
  const doc = await openPdfDocument(file);
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

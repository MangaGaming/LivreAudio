import * as pdfjs from 'pdfjs-dist';
// @ts-ignore - Vite will handle the ?url suffix for the worker
import pdfWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;

export async function extractTextFromPdf(file: File): Promise<string> {
  const arrayBuffer = await file.arrayBuffer();
  const loadingTask = pdfjs.getDocument({ data: arrayBuffer });
  const pdf = await loadingTask.promise;
  let fullText = '';

  for (let i = 1; i <= pdf.numPages; i++) {
    try {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      const pageText = textContent.items
        .filter((item: any) => 'str' in item)
        .map((item: any) => item.str)
        .join(' ');
      fullText += pageText + ' ';
      
      // Add a page marker
      if (i % 2 === 0) fullText += '\n\n';
    } catch (err) {
      console.warn(`Error extracting page ${i}:`, err);
    }
  }

  console.log(`Extracted total characters: ${fullText.length} from ${pdf.numPages} pages.`);
  return fullText.trim();
}

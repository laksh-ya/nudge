"use client";

/** Read a statement file in the browser. Nothing leaves the device until the user confirms. */
export type ParsedFile =
  | { kind: "csv" | "xlsx"; table: string[][] }
  | { kind: "pdf"; lines: string[] };

function decode(buffer: ArrayBuffer): string {
  const utf8 = new TextDecoder("utf-8").decode(buffer);
  const bad = (utf8.match(/�/g) ?? []).length;
  // Alipay and WeChat exports are often GBK encoded.
  if (bad > 3) {
    try {
      return new TextDecoder("gbk").decode(buffer);
    } catch {}
  }
  return utf8;
}

export async function parseFile(file: File): Promise<ParsedFile> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".pdf") || file.type === "application/pdf") return { kind: "pdf", lines: await pdfLines(file) };
  if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
    const { readSheet } = await import("read-excel-file/browser");
    const rows = await readSheet(file);
    return {
      kind: "xlsx",
      table: rows.map((r) =>
        r.map((c) => (c === null || c === undefined ? "" : c instanceof Date ? c.toISOString().slice(0, 19).replace("T", " ") : String(c))),
      ),
    };
  }
  const Papa = (await import("papaparse")).default;
  const text = decode(await file.arrayBuffer());
  const table = Papa.parse<string[]>(text, { skipEmptyLines: true }).data;
  return { kind: "csv", table };
}

async function pdfLines(file: File): Promise<string[]> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const lines: string[] = [];
  for (let p = 1; p <= Math.min(doc.numPages, 60); p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const rows = new Map<number, { x: number; s: string }[]>();
    for (const item of content.items) {
      if (!("str" in item) || !item.str.trim()) continue;
      const y = Math.round(item.transform[5] / 3) * 3;
      const list = rows.get(y) ?? [];
      list.push({ x: item.transform[4], s: item.str });
      rows.set(y, list);
    }
    for (const y of [...rows.keys()].sort((a, b) => b - a)) {
      lines.push(
        rows
          .get(y)!
          .sort((a, b) => a.x - b.x)
          .map((i) => i.s)
          .join("  "),
      );
    }
  }
  return lines;
}

/** On-device OCR. Language data loads from a CDN on first use. */
export async function ocr(file: Blob, onProgress?: (p: number) => void): Promise<string> {
  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker("eng", 1, {
    logger: (m: { status: string; progress: number }) => {
      if (m.status === "recognizing text") onProgress?.(m.progress);
    },
  });
  try {
    const { data } = await worker.recognize(file);
    return data.text;
  } finally {
    await worker.terminate();
  }
}

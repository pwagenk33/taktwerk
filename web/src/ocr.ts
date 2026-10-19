/**
 * Receipt OCR in the browser with tesseract.js, loaded on first use so the app bundle stays small.
 * Recognition runs in a web worker on the phone or PC; the photo never leaves the device.
 */
const VERSION = "6.0.1";
/** Served by the own server (web/public/ocr, filled by scripts/copy-ocr.mjs); the file-based demo falls back to the CDN. */
const LOCAL = typeof location !== "undefined" && location.protocol.startsWith("http");
const CDN = LOCAL ? `${location.origin}/ocr` : `https://cdn.jsdelivr.net/npm/tesseract.js@${VERSION}/dist`;
const CORE = LOCAL ? `${location.origin}/ocr` : "https://cdn.jsdelivr.net/npm/tesseract.js-core@6.0.0";
const LANGS = LOCAL ? `${location.origin}/ocr` : "https://tessdata.projectnaptha.com/4.0.0_best_int";

interface TesseractLike {
  createWorker(langs: string, oem?: number, options?: Record<string, unknown>): Promise<{
    recognize(image: File | Blob | string): Promise<{ data: { text: string; confidence: number } }>;
    terminate(): Promise<void>;
  }>;
}

declare global {
  interface Window { Tesseract?: TesseractLike }
}

let loading: Promise<TesseractLike> | null = null;

function loadScript(): Promise<TesseractLike> {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = `${CDN}/tesseract.min.js`;
      s.async = true;
      s.onload = () => (window.Tesseract ? resolve(window.Tesseract) : reject(new Error("Texterkennung konnte nicht geladen werden.")));
      s.onerror = () => { loading = null; reject(new Error("Texterkennung konnte nicht geladen werden. Bist du online?")); };
      document.head.appendChild(s);
    });
  }
  return loading;
}

/** Downscales a photo to at most 1600 px on the long side, which is plenty for receipts and much faster. */
async function shrink(file: File): Promise<Blob> {
  if (!file.type.startsWith("image/") || !("createImageBitmap" in window)) return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    if (scale === 1) return file;
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("Bild konnte nicht verkleinert werden."))), "image/jpeg", 0.9));
  } catch {
    return file;
  }
}

/** Reads the text of a receipt photo. `onProgress` gets 0–1 while loading and recognising. */
export async function recognizeReceipt(file: File, onProgress: (p: number, step: string) => void): Promise<{ text: string; confidence: number }> {
  if (file.type === "application/pdf") throw new Error("PDF-Belege kann die Texterkennung nicht lesen, bitte ein Foto verwenden.");
  onProgress(0.05, "Texterkennung laden");
  const T = await loadScript();
  const image = await shrink(file);
  const worker = await T.createWorker("deu+eng", 1, {
    workerPath: `${CDN}/worker.min.js`,
    corePath: CORE,
    langPath: LANGS,
    logger: (m: { status: string; progress: number }) => {
      if (m.status === "recognizing text") onProgress(0.3 + m.progress * 0.7, "Beleg lesen");
      else if (m.status.includes("loading")) onProgress(0.15, "Sprachdaten laden");
    },
  });
  try {
    const { data } = await worker.recognize(image);
    return { text: data.text, confidence: data.confidence };
  } finally {
    await worker.terminate();
  }
}

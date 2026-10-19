// Copies the tesseract.js runtime and the German/English language data into public/ocr,
// so receipt OCR runs from the own server (no CDN, nothing leaves the installation).
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "public", "ocr");
mkdirSync(out, { recursive: true });
const pkgDir = (name) => dirname(require.resolve(`${name}/package.json`));
const files = [
  [join(pkgDir("tesseract.js"), "dist", "tesseract.min.js"), "tesseract.min.js"],
  [join(pkgDir("tesseract.js"), "dist", "worker.min.js"), "worker.min.js"],
  [join(pkgDir("tesseract.js-core"), "tesseract-core-simd-lstm.wasm.js"), "tesseract-core-simd-lstm.wasm.js"],
  [join(pkgDir("tesseract.js-core"), "tesseract-core-lstm.wasm.js"), "tesseract-core-lstm.wasm.js"],
  [join(pkgDir("@tesseract.js-data/deu"), "4.0.0_best_int", "deu.traineddata.gz"), "deu.traineddata.gz"],
  [join(pkgDir("@tesseract.js-data/eng"), "4.0.0_best_int", "eng.traineddata.gz"), "eng.traineddata.gz"],
];
for (const [src, name] of files) copyFileSync(src, join(out, name));
console.log(`OCR-Dateien nach public/ocr kopiert (${files.length})`);

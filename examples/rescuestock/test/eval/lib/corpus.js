// Loads the EXT-1 corpus (test/fixtures/extraction) for the fake-mode eval and the live runner. Not a test file.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CORPUS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'extraction');
export const IMAGE_MIME = 'image/png';

/** -> { manifest, cases: [{ ...case, text, image: { bytes, mime } | null }] } */
export function loadCorpus(dir = CORPUS_DIR) {
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const cases = manifest.cases.map((c) => {
    const imageId = c.imageRef ?? c.image?.id ?? null;
    return {
      ...c,
      text: readFileSync(join(dir, c.textFile), 'utf8').replace(/\n$/, ''),
      image: imageId ? { bytes: readFileSync(join(dir, 'images', `${imageId}.png`)), mime: IMAGE_MIME } : null,
    };
  });
  return { manifest, cases };
}

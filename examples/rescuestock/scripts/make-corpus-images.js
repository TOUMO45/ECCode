// Renders the EXT-1 package-label images from TEXT, so no binary is ever made by hand, and writes
// test/fixtures/extraction/{images,labels}/ and fake-image-map.json from test/fixtures/extraction/manifest.json.
//
//   node scripts/make-corpus-images.js          (npm run corpus:images)
//
// Pure Node: a built-in 5x7 bitmap font, optional box blur and crop, an 8-bit greyscale PNG written with zlib.
// No browser, no network, no dependency. The committed PNGs are the ground truth for the fake image map (keyed by the
// sha256 of the PNG bytes); the eval test re-renders every image and compares the PIXELS, so a different zlib version
// that compresses differently does not break it. Changing a label or a render option means bumping corpusVersion.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync, inflateSync } from 'node:zlib';

export const CORPUS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'extraction');

// ---- 5x7 font (upper case letters, digits and a little punctuation) ---------------------------------------------

const GLYPHS = {
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.####'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '#####'],
  J: ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  N: ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '##.##', '#...#'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
  0: ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  1: ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  2: ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  3: ['#####', '...#.', '..#..', '...#.', '....#', '#...#', '.###.'],
  4: ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  5: ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  6: ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  7: ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  8: ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  9: ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
  '.': ['.....', '.....', '.....', '.....', '.....', '.##..', '.##..'],
  ',': ['.....', '.....', '.....', '.....', '..##.', '..##.', '.##..'],
  ':': ['.....', '.##..', '.##..', '.....', '.##..', '.##..', '.....'],
  '-': ['.....', '.....', '.....', '#####', '.....', '.....', '.....'],
  '/': ['....#', '....#', '...#.', '..#..', '.#...', '#....', '#....'],
  $: ['..#..', '.####', '#.#..', '.###.', '..#.#', '####.', '..#..'],
  '+': ['.....', '..#..', '..#..', '#####', '..#..', '..#..', '.....'],
  '%': ['##..#', '##..#', '...#.', '..#..', '.#...', '#..##', '#..##'],
  '(': ['...#.', '..#..', '.#...', '.#...', '.#...', '..#..', '...#.'],
  ')': ['.#...', '..#..', '...#.', '...#.', '...#.', '..#..', '.#...'],
  '=': ['.....', '.....', '#####', '.....', '#####', '.....', '.....'],
  '!': ['..#..', '..#..', '..#..', '..#..', '..#..', '.....', '..#..'],
};

const GLYPH_W = 5;
const GLYPH_H = 7;
const ADVANCE = 6; // glyph width plus one column of space
const LINE_ADVANCE = 11; // glyph height plus four rows of space

// ---- rendering ------------------------------------------------------------------------------------------------------

function boxBlur(pixels, width, height, radius) {
  if (radius <= 0) return pixels;
  const pass = (src, horizontal) => {
    const dst = new Uint8Array(src.length);
    const lines = horizontal ? height : width;
    const length = horizontal ? width : height;
    const at = (line, i) => (horizontal ? line * width + i : i * width + line);
    for (let line = 0; line < lines; line += 1) {
      let sum = 0;
      for (let i = -radius; i <= radius; i += 1) sum += src[at(line, Math.min(length - 1, Math.max(0, i)))];
      for (let i = 0; i < length; i += 1) {
        dst[at(line, i)] = Math.floor(sum / (2 * radius + 1));
        sum += src[at(line, Math.min(length - 1, i + radius + 1))] - src[at(line, Math.max(0, i - radius))];
      }
    }
    return dst;
  };
  let out = pixels;
  for (let n = 0; n < 3; n += 1) out = pass(pass(out, true), false);
  return out;
}

/**
 * renderLabel({ labelLines, render: { scale = 4, margin = 16, blur = 0, crop? } }) -> { width, height, pixels }
 * labelLines are upper-case text lines. crop = { line, rows }: keep everything above text line `line` plus `rows`
 * rows of its glyphs (a cropped label whose last line is cut off).
 */
export function renderLabel({ labelLines, render = {} }) {
  const { scale = 4, margin = 16, blur = 0, crop = null } = render;
  const longest = Math.max(...labelLines.map((l) => l.length));
  const width = margin * 2 + (longest * ADVANCE - 1) * scale;
  const fullHeight = margin * 2 + ((labelLines.length - 1) * LINE_ADVANCE + GLYPH_H) * scale;
  const pixels = new Uint8Array(width * fullHeight).fill(255);
  labelLines.forEach((line, row) => {
    [...line].forEach((ch, col) => {
      const glyph = GLYPHS[ch];
      if (!glyph) throw new RangeError(`no glyph for ${JSON.stringify(ch)} in a label`);
      for (let gy = 0; gy < GLYPH_H; gy += 1) {
        for (let gx = 0; gx < GLYPH_W; gx += 1) {
          if (glyph[gy][gx] !== '#') continue;
          const x0 = margin + (col * ADVANCE + gx) * scale;
          const y0 = margin + (row * LINE_ADVANCE + gy) * scale;
          for (let dy = 0; dy < scale; dy += 1) for (let dx = 0; dx < scale; dx += 1) pixels[(y0 + dy) * width + x0 + dx] = 0;
        }
      }
    });
  });
  const blurred = boxBlur(pixels, width, fullHeight, blur);
  const height = crop ? Math.min(fullHeight, margin + (crop.line * LINE_ADVANCE + crop.rows) * scale) : fullHeight;
  return { width, height, pixels: blurred.slice(0, width * height) };
}

// ---- PNG (8-bit greyscale, no interlace, filter 0) ----------------------------------------------------------------

function chunk(type, data) {
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, checksum]);
}

export function encodePng({ width, height, pixels }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width + 1)] = 0; // filter: none
    Buffer.from(pixels.buffer, pixels.byteOffset + y * width, width).copy(raw, y * (width + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Decodes a PNG written by encodePng (8-bit greyscale, filter 0) back to { width, height, pixels }. */
export function decodePng(bytes) {
  if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new TypeError('not a PNG');
  let offset = 8;
  let header = null;
  const idat = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString('ascii');
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') header = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], colour: data[9] };
    if (type === 'IDAT') idat.push(data);
    offset += 12 + length;
  }
  if (!header || header.depth !== 8 || header.colour !== 0) throw new TypeError('only 8-bit greyscale PNGs are supported');
  const raw = inflateSync(Buffer.concat(idat));
  const pixels = new Uint8Array(header.width * header.height);
  for (let y = 0; y < header.height; y += 1) {
    if (raw[y * (header.width + 1)] !== 0) throw new TypeError('only filter 0 is supported');
    raw.copy(pixels, y * header.width, y * (header.width + 1) + 1, (y + 1) * (header.width + 1));
  }
  return { width: header.width, height: header.height, pixels };
}

// ---- the corpus -------------------------------------------------------------------------------------------------

export function loadManifest(dir = CORPUS_DIR) {
  return JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
}

export const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** The image cases of a manifest, each with its rendered PNG bytes and the fake-map entry derived from `fakeRead`. */
export function renderCorpus(manifest) {
  const images = [];
  for (const c of manifest.cases) {
    if (!c.image) continue;
    const png = encodePng(renderLabel(c.image));
    images.push({ caseId: c.id, imageId: c.image.id, png, sha256: sha256Hex(png), labelText: c.image.labelLines.join('\n'), fakeRead: c.image.fakeRead });
  }
  return images;
}

export function buildFakeImageMap(images) {
  const map = {};
  for (const img of images) map[img.sha256] = { imageId: img.imageId, ...img.fakeRead };
  return map;
}

function main() {
  const manifest = loadManifest();
  const images = renderCorpus(manifest);
  mkdirSync(join(CORPUS_DIR, 'images'), { recursive: true });
  mkdirSync(join(CORPUS_DIR, 'labels'), { recursive: true });
  for (const img of images) {
    writeFileSync(join(CORPUS_DIR, 'images', `${img.imageId}.png`), img.png);
    writeFileSync(join(CORPUS_DIR, 'labels', `${img.imageId}.txt`), `${img.labelText}\n`);
  }
  writeFileSync(join(CORPUS_DIR, 'fake-image-map.json'), `${JSON.stringify(buildFakeImageMap(images), null, 2)}\n`);
  process.stdout.write(`wrote ${images.length} images, labels and fake-image-map.json for corpus ${manifest.corpusVersion}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();

'use strict';
// Retrieval: BM25 keyword ranking blended with character-trigram cosine
// similarity (tolerates inflections, partial identifiers and typos such as
// "ECONNRESET"/"connection reset"). When config.memory.embedCommand is set,
// an external embedder adds true semantic similarity. Without it, retrieval
// is lexical — the toolkit does not claim semantic search it cannot do.

const { spawnSync } = require('child_process');
const { EccodeError } = require('../util');

const STOP = new Set('a an and are as at be by for from has in is it its of on or that the to was were will with this when not no'.split(' '));

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

function trigrams(text) {
  const s = ` ${String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
  const v = new Map();
  for (let i = 0; i < s.length - 2; i++) {
    const g = s.slice(i, i + 3);
    v.set(g, (v.get(g) || 0) + 1);
  }
  return v;
}

function cosineMaps(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [, x] of a) na += x * x;
  for (const [k, y] of b) {
    nb += y * y;
    const x = a.get(k);
    if (x) dot += x * y;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

function bm25Scores(docsTokens, queryTokens, { k1 = 1.2, b = 0.75 } = {}) {
  const N = docsTokens.length;
  const avgdl = docsTokens.reduce((s, d) => s + d.length, 0) / (N || 1);
  const df = new Map();
  for (const d of docsTokens) for (const t of new Set(d)) df.set(t, (df.get(t) || 0) + 1);
  return docsTokens.map((d) => {
    const tf = new Map();
    for (const t of d) tf.set(t, (tf.get(t) || 0) + 1);
    let score = 0;
    for (const q of new Set(queryTokens)) {
      const f = tf.get(q);
      if (!f) continue;
      const idf = Math.log(1 + (N - df.get(q) + 0.5) / (df.get(q) + 0.5));
      score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / (avgdl || 1)));
    }
    return score;
  });
}

function embed(command, texts) {
  const res = spawnSync(command, { shell: true, input: JSON.stringify({ texts }), encoding: 'utf8', timeout: 60000 });
  if (res.status !== 0) throw new EccodeError('EMBEDDER_FAILED', `embedCommand failed: ${(res.stderr || '').slice(0, 300)}`);
  const out = JSON.parse(res.stdout);
  if (!Array.isArray(out.vectors) || out.vectors.length !== texts.length) throw new EccodeError('EMBEDDER_FAILED', 'embedCommand must print {"vectors": [...]} with one vector per text');
  return out.vectors;
}

/**
 * Rank documents [{id, text}] for a query.
 * Returns [{id, score, components:{bm25, trigram, embedding?}}] sorted desc.
 */
function rank(docs, query, { embedCommand } = {}) {
  if (!docs.length) return [];
  const qTokens = tokenize(query);
  const bm = bm25Scores(docs.map((d) => tokenize(d.text)), qTokens);
  const maxBm = Math.max(...bm, 0) || 1;
  const qTri = trigrams(query);
  let emb = null;
  if (embedCommand) {
    const vecs = embed(embedCommand, [query, ...docs.map((d) => d.text)]);
    emb = vecs.slice(1).map((v) => cosine(vecs[0], v));
  }
  return docs
    .map((d, i) => {
      const components = { bm25: bm[i] / maxBm, trigram: cosineMaps(qTri, trigrams(d.text)) };
      if (emb) components.embedding = emb[i];
      const score = emb ? 0.4 * components.bm25 + 0.2 * components.trigram + 0.4 * emb[i] : 0.65 * components.bm25 + 0.35 * components.trigram;
      return { id: d.id, score: Math.round(score * 1000) / 1000, components };
    })
    .sort((a, b) => b.score - a.score);
}

function similarity(a, b) {
  return cosineMaps(trigrams(a), trigrams(b));
}

module.exports = { rank, tokenize, similarity };

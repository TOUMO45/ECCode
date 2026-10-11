// Bidirectional-text isolation for text that somebody else wrote (FU-58, SEC-F-I6). A supplier's refusal reason is
// composed into sentences ("Supplier A refused the order: <reason>. No money was taken."). A bidi override or isolate
// control inside the reason must not reorder the words around it, so the reason is wrapped in <bdi dir="auto">, whose
// content is laid out as a unit apart from its surroundings. The server also refuses these controls; this is the second
// layer. Nothing is removed or rewritten here: the reason is shown as it was given.

import { el } from './dom.js';

// "<label>" + isolated reason. The label stays outside the isolate, so it keeps the page's direction.
export function reasonNodes(label, reason) {
  return [label, el('bdi', { dir: 'auto', text: reason })];
}

// The server's sentence for a refusal (src/domain/explain.js SUPPLIER_REFUSED).
const REFUSAL_SENTENCE = /^([^\n]*? refused the order: )([\s\S]+?)(\. No money was taken\.)$/;

// A server message that may carry a supplier's words. The reason inside a refusal sentence is isolated on its own;
// any other message is isolated as a whole, so nothing in it can reach the text next to it.
export function messageNodes(text) {
  const m = REFUSAL_SENTENCE.exec(text);
  if (m) return [m[1], el('bdi', { dir: 'auto', text: m[2] }), m[3]];
  return [el('bdi', { dir: 'auto', text })];
}

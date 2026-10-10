// DOM construction. Every node is built with createElement, createTextNode and attribute setters; text is set
// with textContent only. There is no markup parsing anywhere in the SPA (spec: Security, Output encoding), so
// server, model and catalog text is always data. The document is injectable so view code can run under plain
// `node --test` against a tiny fake.

let injected = null;

export function setDocument(doc) {
  injected = doc;
}

export function getDocument() {
  const doc = injected ?? globalThis.document;
  if (!doc) throw new Error('No document is available');
  return doc;
}

const ATTR_NAME = /^[a-z][a-z0-9-]*$/;
const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction']);
const REFUSED_ATTRS = new Set(['style', 'srcdoc']);

// href/src/action may only point at this app (a path or a hash) or at http(s).
function isAllowedUrl(value) {
  const v = String(value).trim();
  if (v.startsWith('#') || v.startsWith('/') || v.startsWith('?')) return !v.startsWith('//');
  return /^https?:\/\//i.test(v);
}

export function setAttr(node, name, value) {
  if (!ATTR_NAME.test(name) || name.startsWith('on') || REFUSED_ATTRS.has(name)) {
    throw new Error(`Attribute "${name}" is not allowed`);
  }
  if (URL_ATTRS.has(name) && !isAllowedUrl(value)) throw new Error(`Attribute "${name}" has a URL that is not allowed`);
  node.setAttribute(name, value === true ? '' : String(value));
}

export function append(parent, children) {
  const doc = getDocument();
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(parent, child);
    else if (typeof child === 'object') parent.appendChild(child);
    else parent.appendChild(doc.createTextNode(String(child)));
  }
  return parent;
}

/**
 * el(tag, props, children)
 *   props.text      -> textContent
 *   props.testid    -> data-testid
 *   props.on        -> { event: handler } through addEventListener
 *   props.data      -> { name: value } as data-name attributes
 *   other keys      -> attributes (false, null and undefined are skipped; true sets an empty attribute)
 */
export function el(tag, props = {}, children = []) {
  const node = getDocument().createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'text') node.textContent = String(value);
    else if (key === 'testid') node.setAttribute('data-testid', String(value));
    else if (key === 'on') {
      for (const [type, handler] of Object.entries(value)) node.addEventListener(type, handler);
    } else if (key === 'data') {
      for (const [name, v] of Object.entries(value)) {
        if (v !== undefined && v !== null) setAttr(node, `data-${name}`, v);
      }
    } else setAttr(node, key === 'className' ? 'class' : key, value);
  }
  return append(node, children);
}

export function fragment(children = []) {
  return append(getDocument().createDocumentFragment(), children);
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function replaceContent(node, children) {
  clear(node);
  return append(node, children);
}

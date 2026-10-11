// An axe-free accessibility audit of what Chromium actually renders (NFR2, RS-35). No library: the checks are computed from the
// live DOM and the computed styles, so a regression in a stylesheet or a component shows here and not only in a unit test.
//
// auditPage(page, { width }) -> { problems: string[], stats }
//   - structure: exactly one h1 and one main, a banner and a polite live region (#announcer), lang on <html>;
//   - names: every visible interactive element (link, button, input, select, textarea, summary) has an accessible name
//     (aria-label, aria-labelledby, a label, its own text, title, or value of a submit button); every aria-labelledby /
//     aria-describedby / aria-controls reference resolves; nothing focusable sits inside aria-hidden;
//   - target size: visible buttons, text controls and summaries are at least 44 CSS px high and wide enough; standalone links (a link
//     that is the whole text of its block) are at least 44 px high; inline links in running text are exempt (WCAG 2.5.8);
//   - contrast: every visible text node, against the nearest opaque background colour, reaches 4.5:1 (3:1 for large text); an element
//     on a background image or gradient is listed in stats.skippedContrast, not silently passed;
//   - no horizontal scroll: the document is not wider than the viewport.
// keyboardWalk(page) presses Tab through the page and reports, for each stop, whether a focus indicator is drawn (outline of at least
// 2 px, or a box-shadow), whether the stop is inside the viewport after scrolling, and whether the walk wraps (no keyboard trap).
import assert from 'node:assert/strict';

/* Runs in the page. Kept as one self-contained function. */
function auditInPage({ width }) {
  const problems = [];
  const skippedContrast = [];
  const visible = (el) => {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const box = el.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return false;
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.display === 'none' || s.visibility === 'hidden' || n.hidden) return false;
    }
    return true;
  };
  const label = (el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.getAttribute('data-testid') ? `[${el.getAttribute('data-testid')}]` : ''}`;
  const text = (el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim();

  // ---- structure
  const count = (selector) => document.querySelectorAll(selector).length;
  if (count('h1') !== 1) problems.push(`expected one h1, found ${count('h1')}`);
  if (count('main, [role="main"]') !== 1) problems.push(`expected one main landmark, found ${count('main, [role="main"]')}`);
  if (count('header, [role="banner"]') < 1) problems.push('no banner landmark');
  const live = document.getElementById('announcer');
  if (!live || live.getAttribute('aria-live') !== 'polite') problems.push('#announcer with aria-live="polite" is missing');
  if (!document.documentElement.getAttribute('lang')) problems.push('<html> has no lang');

  // ---- accessible names and references
  const interactive = [...document.querySelectorAll('a[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex]:not([tabindex="-1"])')].filter(visible);
  const nameOf = (el) => {
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) return labelledBy.split(/\s+/).map((id) => text(document.getElementById(id) ?? document.createElement('i'))).join(' ').trim();
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return aria.trim();
    if (el.labels && el.labels.length > 0) return [...el.labels].map(text).join(' ').trim();
    if (el.tagName === 'INPUT' && ['submit', 'button', 'reset'].includes(el.type)) return (el.value || '').trim();
    const own = text(el);
    if (own) return own;
    return (el.getAttribute('title') ?? '').trim();
  };
  for (const el of interactive) {
    if (!nameOf(el)) problems.push(`${label(el)} has no accessible name`);
    if (el.closest('[aria-hidden="true"]')) problems.push(`${label(el)} is focusable inside aria-hidden`);
  }
  for (const attr of ['aria-labelledby', 'aria-describedby', 'aria-controls']) {
    for (const el of document.querySelectorAll(`[${attr}]`)) {
      for (const id of el.getAttribute(attr).split(/\s+/).filter(Boolean)) {
        if (!document.getElementById(id)) problems.push(`${label(el)} ${attr} points at a missing #${id}`);
      }
    }
  }

  // ---- target size (44 CSS px)
  const MIN = 44;
  const sized = [];
  for (const el of interactive) {
    const tag = el.tagName;
    const type = (el.getAttribute('type') ?? '').toLowerCase();
    let target = el;
    if (tag === 'INPUT' && (type === 'checkbox' || type === 'radio')) target = el.labels?.[0] ?? el;
    const box = target.getBoundingClientRect();
    if (tag === 'A') {
      const parentText = text(el.parentElement ?? el);
      const standalone = parentText === text(el) || el.closest('li, td, th, .state, .notice, nav, .toolbar') !== null && parentText.length <= text(el).length + 4;
      if (!standalone) continue; // an inline link inside a sentence
      if (box.height + 0.5 < MIN) problems.push(`link ${label(el)} "${text(el).slice(0, 40)}" is ${Math.round(box.height)} px high (< ${MIN})`);
      sized.push(label(el));
      continue;
    }
    if (box.height + 0.5 < MIN) problems.push(`${label(el)} "${text(el).slice(0, 40)}" is ${Math.round(box.height)} px high (< ${MIN})`);
    if ((tag === 'BUTTON' || tag === 'SUMMARY') && box.width + 0.5 < MIN) problems.push(`${label(el)} is ${Math.round(box.width)} px wide (< ${MIN})`);
    sized.push(label(el));
  }

  // ---- contrast
  const parseColor = (value) => {
    const m = /rgba?\(([^)]+)\)/.exec(value);
    if (!m) return null;
    const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return { r, g, b, a };
  };
  const over = (top, bottom) => {
    const a = top.a + bottom.a * (1 - top.a);
    if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
    return {
      r: (top.r * top.a + bottom.r * bottom.a * (1 - top.a)) / a,
      g: (top.g * top.a + bottom.g * bottom.a * (1 - top.a)) / a,
      b: (top.b * top.a + bottom.b * bottom.a * (1 - top.a)) / a,
      a,
    };
  };
  const lum = ({ r, g, b }) => {
    const f = (v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const backgroundOf = (el) => {
    const chain = [];
    for (let n = el; n; n = n.parentElement) chain.push(n);
    let color = { r: 255, g: 255, b: 255, a: 1 }; // the canvas
    for (const n of chain.reverse()) {
      const s = getComputedStyle(n);
      if (s.backgroundImage && s.backgroundImage !== 'none') return null;
      const bg = parseColor(s.backgroundColor);
      if (bg && bg.a > 0) color = over(bg, color);
    }
    return color;
  };
  const opacityOf = (el) => {
    let o = 1;
    for (let n = el; n; n = n.parentElement) o *= Number(getComputedStyle(n).opacity);
    return o;
  };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  let checked = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.nodeValue.trim()) continue;
    const el = node.parentElement;
    if (!el || seen.has(el) || !visible(el)) continue;
    if (el.closest('script, style, noscript, [aria-hidden="true"], .visually-hidden, .sr-only')) continue;
    seen.add(el);
    const style = getComputedStyle(el);
    const bg = backgroundOf(el);
    if (bg === null) {
      skippedContrast.push(label(el));
      continue;
    }
    const fgRaw = parseColor(style.color);
    if (!fgRaw) continue;
    const fg = over({ ...fgRaw, a: fgRaw.a * opacityOf(el) }, bg);
    const l1 = lum(fg);
    const l2 = lum(bg);
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    const size = parseFloat(style.fontSize);
    const bold = Number(style.fontWeight) >= 700;
    const large = size >= 24 || (size >= 18.66 && bold);
    checked += 1;
    if (ratio + 0.005 < (large ? 3 : 4.5)) problems.push(`contrast ${ratio.toFixed(2)}:1 for "${text(el).slice(0, 40)}" in ${label(el)} (needs ${large ? 3 : 4.5})`);
  }

  // ---- no horizontal scroll
  const scroll = document.documentElement.scrollWidth;
  if (scroll > window.innerWidth) problems.push(`horizontal scroll: scrollWidth ${scroll} > viewport ${window.innerWidth} at ${width} px`);

  return { problems, stats: { interactive: interactive.length, sized: sized.length, contrastChecked: checked, skippedContrast } };
}

export async function auditPage(page, { width }) {
  return page.evaluate(auditInPage, { width });
}

/** Asserts an audit is clean and non-vacuous: it looked at controls and at text. */
export async function assertAccessible(page, { width, label }) {
  const { problems, stats } = await auditPage(page, { width });
  assert.deepEqual(problems, [], `${label}: accessibility problems at ${width} px`);
  assert.ok(stats.contrastChecked >= 5, `${label}: the contrast check looked at ${stats.contrastChecked} text elements (it must not be vacuous)`);
  return stats;
}

/**
 * Presses Tab from the top of the document through every stop. Returns { stops, wraps, problems }.
 * A stop must draw a focus indicator (outline >= 2 px or a box-shadow) and be scrolled into view.
 */
const NATIVE_SELECTOR = 'input[type="datetime-local"], input[type="date"], input[type="time"]';

export async function keyboardWalk(page, { max = 200 } = {}) {
  await page.evaluate(() => {
    document.activeElement?.blur?.();
  });
  // Pictures of the native segmented controls while nothing has focus (see the native branch below).
  const baselines = [];
  const natives = page.locator(NATIVE_SELECTOR);
  for (let i = 0; i < (await natives.count()); i += 1) baselines.push((await natives.nth(i).isVisible()) ? await natives.nth(i).screenshot() : null);
  await page.evaluate(() => {
    document.activeElement?.blur?.();
    window.scrollTo(0, 0);
  });
  const stops = [];
  const problems = [];
  let wraps = false; // true once Tab leaves the document (focus goes to the browser): the walk ended without a trap
  for (let i = 0; i < max; i += 1) {
    await page.keyboard.press('Tab');
    const stop = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return { body: true };
      const s = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      const outline = parseFloat(s.outlineWidth) > 0 && s.outlineStyle !== 'none';
      const hasRing = (outline && parseFloat(s.outlineWidth) >= 2) || (s.boxShadow && s.boxShadow !== 'none');
      return {
        id: `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.getAttribute('data-testid') ? `[${el.getAttribute('data-testid')}]` : ''}`,
        name: (el.getAttribute('aria-label') || el.textContent || el.value || '').replace(/\s+/g, ' ').trim().slice(0, 40),
        hasRing,
        onScreen: box.bottom > 0 && box.top < window.innerHeight && box.right > 0 && box.left < window.innerWidth,
        matchesFocusVisible: el.matches(':focus-visible'),
        native: el.matches('input[type="datetime-local"], input[type="date"], input[type="time"]'),
      };
    });
    if (stop.body) {
      wraps = true;
      break;
    }
    stops.push(stop);
    if (stop.native) {
      // A native segmented date-time control draws its own highlight on the focused segment, not the app's ring and not on the host
      // element, so the computed style cannot show it. Compare what is drawn: a picture of the control while it has focus against a
      // picture of the same control without focus. They must differ. (Segment highlight, not the app's 3 px ring: g1's remaining issue.)
      const handle = await page.evaluateHandle(() => document.activeElement);
      const focused = await handle.asElement().screenshot();
      const index = await page.evaluate((s) => [...document.querySelectorAll(s)].indexOf(document.activeElement), NATIVE_SELECTOR);
      if (baselines[index] && focused.equals(baselines[index])) problems.push(`nothing is drawn for keyboard focus on the native control ${stop.id}`);
      if (!stop.onScreen) problems.push(`${stop.id} "${stop.name}" has focus but is not on screen`);
      continue;
    }
    if (!stop.hasRing) problems.push(`no visible focus indicator on ${stop.id} "${stop.name}"`);
    if (!stop.onScreen) problems.push(`${stop.id} "${stop.name}" has focus but is not on screen`);
    if (!stop.matchesFocusVisible) problems.push(`${stop.id} "${stop.name}" does not match :focus-visible after Tab`);
  }
  return { stops, wraps, problems };
}

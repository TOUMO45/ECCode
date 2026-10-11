// Keyboard-only driving of the page (NFR2). Nothing here clicks, hovers or uses `fill`: focus moves with Tab, text is typed with the
// keyboard, buttons are pressed with Enter. forbidPointer() makes a pointer event a recorded failure, so a "keyboard-only" test cannot
// quietly use the mouse.
import assert from 'node:assert/strict';

/** Records every real mouse pointerdown of every document the context opens (the app page and the approval page). */
export async function forbidPointer(context) {
  const events = [];
  await context.addInitScript(() => {
    addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse') console.info(`rs-pointer-event ${location.pathname}`);
    }, true);
  });
  context.on('console', (message) => {
    if (message.text().startsWith('rs-pointer-event')) events.push(message.text());
  });
  return events;
}

const matches = (page, selector) => page.evaluate((s) => document.activeElement?.matches(s) === true, selector);

/** Presses Tab until the element that matches `selector` has focus. Throws after `max` presses. */
export async function tabTo(page, selector, { max = 400 } = {}) {
  for (let i = 0; i <= max; i += 1) {
    if (await matches(page, selector)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error(`Tab did not reach ${selector} within ${max} presses`);
}

/** Tab to the field, select its current content and type `text` (a text field, a textarea or a select). */
export async function typeInto(page, selector, text) {
  await tabTo(page, selector);
  await page.keyboard.press('Control+A');
  await page.keyboard.type(text);
}

/** Tab to a button or link and press Enter. */
export async function pressEnterOn(page, selector) {
  await tabTo(page, selector);
  await page.keyboard.press('Enter');
}

/** Types a datetime-local value (en-US field order: month day year hour minute AM/PM) given as YYYY-MM-DDTHH:MM. */
export async function typeDateTime(page, selector, value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  assert.ok(m, `a datetime-local value, got ${value}`);
  const hour = Number(m[4]);
  const twelve = String(hour % 12 === 0 ? 12 : hour % 12).padStart(2, '0');
  await tabTo(page, selector);
  // Month and day advance by themselves after two digits; the year segment takes up to six digits, so ArrowRight ends it.
  await page.keyboard.type(`${m[2]}${m[3]}${m[1]}`);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.type(`${twelve}${m[5]}${hour >= 12 ? 'PM' : 'AM'}`);
  const got = await page.evaluate((s) => document.querySelector(s).value, selector);
  assert.equal(got, value, `the datetime-local field holds ${value} after typing, not ${got}`);
}

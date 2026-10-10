// #/supplier/inventory — the supplier's stock and offers: on hand, price, prep fee, ready time and withdraw. Prices
// are seeded demo prices and are labelled as such. A change that supersedes customers' plans is reported by count only
// (the server sends plan and request ids, never customer details).

import { el, replaceContent } from '../dom.js';
import { EXACT } from '../texts.js';
import {
  centsToDollarInput, formatLocalDateTime, formatUsd, localToTs, parseUsdToCents, utcToLocal,
} from '../format.js';
import { describeError } from '../errors.js';
import { demoBadge, pill } from '../components/badges.js';
import { inputField, checkboxField, submitButton } from '../components/form.js';
import { emptyNode, errorNode, loadingNode, noticeNode, showState, tableRegion } from '../components/notice.js';

const KIND_TEXT = Object.freeze({ bundle: 'Cups and lids bundle', cup: 'Cups', lid: 'Lids' });

export function buildSupplierInventoryViewModel(answer) {
  const rows = (answer.items ?? []).map((it) => ({
    productId: it.productId,
    name: it.name,
    kindText: Object.hasOwn(KIND_TEXT, it.kind) ? KIND_TEXT[it.kind] : String(it.kind),
    capacityText: it.capacityMl === null || it.capacityMl === undefined ? '—' : `${it.capacityMl} ml`,
    diameterText: it.diameterMm === null || it.diameterMm === undefined ? '—' : `${it.diameterMm} mm`,
    onHand: it.onHand,
    reserved: it.reserved,
    offer: it.offer
      ? {
        version: it.offer.version,
        priceText: formatUsd(it.offer.priceCents),
        prepFeeText: formatUsd(it.offer.prepFeeCents),
        readyText: formatLocalDateTime(it.offer.readyAt),
        withdrawn: it.offer.status === 'withdrawn',
        statusText: it.offer.status === 'withdrawn' ? 'Withdrawn' : 'On offer',
      }
      : null,
    demo: it.demo === true,
    form: {
      onHand: String(it.onHand),
      price: it.offer ? centsToDollarInput(it.offer.priceCents) : '',
      prepFee: it.offer ? centsToDollarInput(it.offer.prepFeeCents) : '',
      readyLocal: it.offer ? (utcToLocal(it.offer.readyAt) ?? '') : '',
      withdrawn: it.offer ? it.offer.status === 'withdrawn' : false,
      hasOffer: it.offer !== null && it.offer !== undefined,
    },
    testid: `inventory-${it.productId}`,
  }));
  return { state: rows.length === 0 ? 'empty' : 'ready', rows, priceNotice: EXACT.PRICE_NOTICE };
}

// values are the form strings. Only fields that differ from the row's current values are sent.
// -> { ok, item, errors, changed }
export function buildInventoryPatch(row, values) {
  const errors = {};
  const item = { productId: row.productId };
  const base = row.form;
  const onHand = String(values.onHand ?? '').trim();
  if (onHand !== base.onHand) {
    if (/^\d{1,9}$/.test(onHand)) {
      if (Number(onHand) < row.reserved) errors.onHand = `At least ${row.reserved}: that much is reserved for buyers.`;
      else item.onHand = Number(onHand);
    } else errors.onHand = 'Enter a whole number, 0 or more.';
  }
  if (base.hasOffer) {
    const price = String(values.price ?? '').trim();
    if (price !== base.price) {
      const cents = parseUsdToCents(price);
      if (cents === null) errors.price = 'Enter an amount in dollars, like 30.00.';
      else item.priceCents = cents;
    }
    const prepFee = String(values.prepFee ?? '').trim();
    if (prepFee !== base.prepFee) {
      const cents = parseUsdToCents(prepFee);
      if (cents === null) errors.prepFee = 'Enter an amount in dollars, like 10.00.';
      else item.prepFeeCents = cents;
    }
    const ready = String(values.readyLocal ?? '').trim();
    if (ready !== base.readyLocal) {
      const ts = localToTs(ready);
      if (ts === null) errors.readyLocal = 'Enter a real date and time (Amman time).';
      else item.readyAt = ts;
    }
    if (Boolean(values.withdrawn) !== base.withdrawn) item.withdrawn = Boolean(values.withdrawn);
  }
  const changed = Object.keys(item).length > 1;
  if (!changed && Object.keys(errors).length === 0) errors.form = 'Nothing was changed.';
  return { ok: Object.keys(errors).length === 0, item, errors, changed };
}

function renderRow(row, on, errors) {
  const refs = {};
  const mk = (spec) => {
    const f = inputField({ ...spec, error: errors[spec.name] ?? null });
    refs[spec.name] = f.input;
    return f.row;
  };
  const fields = [
    mk({ id: `inv-${row.productId}-onhand`, name: 'onHand', label: `On hand — ${row.name}`, type: 'number', value: row.form.onHand, min: String(row.reserved), step: '1', inputmode: 'numeric' }),
  ];
  let withdraw = null;
  if (row.form.hasOffer) {
    fields.push(
      mk({ id: `inv-${row.productId}-price`, name: 'price', label: `Price per bundle (US dollars) — ${row.name}`, value: row.form.price, inputmode: 'decimal', autocomplete: 'off' }),
      mk({ id: `inv-${row.productId}-prep`, name: 'prepFee', label: `Prep fee (US dollars) — ${row.name}`, value: row.form.prepFee, inputmode: 'decimal', autocomplete: 'off' }),
      mk({ id: `inv-${row.productId}-ready`, name: 'readyLocal', label: `Ready for pickup at (Amman time) — ${row.name}`, type: 'datetime-local', value: row.form.readyLocal }),
    );
    withdraw = checkboxField({ id: `inv-${row.productId}-withdrawn`, name: 'withdrawn', label: `Withdraw the offer — ${row.name}`, checked: row.form.withdrawn });
    refs.withdrawn = withdraw.input;
    fields.push(withdraw.row);
  }
  const form = el('form', {
    novalidate: true,
    'aria-label': `Edit ${row.name}`,
    testid: `inventory-form-${row.productId}`,
    on: {
      submit: (event) => {
        event.preventDefault();
        on.save(row, {
          onHand: refs.onHand.value,
          price: refs.price?.value,
          prepFee: refs.prepFee?.value,
          readyLocal: refs.readyLocal?.value,
          withdrawn: refs.withdrawn?.checked === true,
        });
      },
    },
  }, [
    ...fields,
    errors.form ? el('p', { class: 'field-error', role: 'alert', text: errors.form }) : null,
    submitButton(`Save changes — ${row.name}`, { testid: `inventory-save-${row.productId}` }),
  ]);
  return form;
}

export function renderSupplierInventory(model, on, rowErrors = {}) {
  if (model.state === 'empty') return [emptyNode({ title: 'No products yet.', testid: 'inventory-empty' })];
  const table = el('table', { class: 'data-table', testid: 'inventory-table' }, [
    el('caption', { class: 'visually-hidden', text: 'Your stock and offers' }),
    el('thead', {}, [el('tr', {}, ['Product', 'Type', 'Size', 'On hand', 'Reserved', 'Price', 'Prep fee', 'Ready at', 'Offer'].map((t) => el('th', { scope: 'col', text: t })))]),
    el('tbody', {}, model.rows.map((r) => el('tr', { testid: r.testid }, [
      el('th', { scope: 'row' }, [el('span', { dir: 'auto', text: r.name }), r.demo ? ' ' : null, r.demo ? demoBadge() : null]),
      el('td', { text: r.kindText }),
      el('td', { text: `${r.capacityText}, ${r.diameterText}` }),
      el('td', { text: String(r.onHand) }),
      el('td', { text: String(r.reserved) }),
      el('td', { text: r.offer ? r.offer.priceText : '—' }),
      el('td', { text: r.offer ? r.offer.prepFeeText : '—' }),
      el('td', { text: r.offer ? r.offer.readyText : '—' }),
      el('td', {}, [r.offer ? pill(r.offer.statusText, r.offer.withdrawn ? 'warn' : 'ok') : el('span', { class: 'muted', text: 'No offer' })]),
    ]))),
  ]);
  return [
    tableRegion('Your stock and offers', table),
    el('p', { class: 'price-notice', testid: 'price-notice', text: model.priceNotice }),
    el('h2', { text: 'Change stock or an offer' }),
    el('ul', { class: 'cards' }, model.rows.map((r) => el('li', { class: 'card', testid: `inventory-edit-${r.productId}` }, [
      el('h3', { dir: 'auto', text: r.name }),
      renderRow(r, on, rowErrors[r.productId] ?? {}),
    ]))),
  ];
}

/** ctx: { api, container, announce } */
export function mountSupplierInventory(ctx, route) {
  const title = el('h1', { id: 'page-title', tabindex: '-1', text: 'Inventory' });
  const feedback = el('div', {});
  const slot = el('div', { testid: 'inventory-slot' });
  replaceContent(ctx.container, [title, feedback, slot]);
  let model = null;
  let busy = false;

  function draw(rowErrors = {}) {
    showState(slot, { kind: 'ready', nodes: renderSupplierInventory(model, on, rowErrors) });
  }

  async function load() {
    showState(slot, { kind: 'loading' });
    try {
      model = buildSupplierInventoryViewModel(await ctx.api.getSupplierInventory());
      draw();
      ctx.announce(model.state === 'empty' ? 'No products yet.' : `${model.rows.length} products loaded.`);
    } catch (err) {
      showState(slot, { kind: 'error', error: err, onRetry: load });
      ctx.announce('Your inventory could not be loaded.');
    }
  }

  const on = {
    save: async (row, values) => {
      if (busy) return;
      const built = buildInventoryPatch(row, values);
      if (!built.ok) {
        draw({ [row.productId]: built.errors });
        ctx.announce('Fix the marked fields and save again.');
        return;
      }
      busy = true;
      replaceContent(feedback, [loadingNode('Saving…')]);
      ctx.announce('Saving…');
      try {
        const answer = await ctx.api.patchSupplierInventory([built.item]);
        const count = Array.isArray(answer.superseded) ? answer.superseded.length : 0;
        const text = count > 0
          ? `Saved. ${count} buyer plan${count === 1 ? ' was' : 's were'} replaced because of this change; those buyers will be asked to review a new plan.`
          : 'Saved.';
        replaceContent(feedback, [noticeNode({ text, tone: 'ok', testid: 'inventory-saved' })]);
        ctx.announce(text);
        await load();
      } catch (err) {
        const d = describeError(err);
        replaceContent(feedback, [errorNode(err)]);
        ctx.announce(`${d.message} ${d.action}`);
      } finally {
        busy = false;
      }
    },
  };

  load();
  return { dispose() {} };
}

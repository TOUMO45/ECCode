// #/admin — demo reset (with force and a reason), the fault form, the timeline table and the metrics. Fault and
// reset calls are audited by the server; the screen only collects values and shows what the server answers.

import { el, replaceContent } from '../dom.js';
import { formatLocalDateTime } from '../format.js';
import { describeError } from '../errors.js';
import { checkboxField, inputField, selectField, submitButton } from '../components/form.js';
import { emptyNode, errorNode, loadingNode, noticeNode, sectionEl, showState, tableRegion } from '../components/notice.js';

export const SUPPLIER_CODES = Object.freeze(['A', 'B', 'C', 'D', 'E']);
const PAYPAL_CALLS = Object.freeze(['create_order', 'authorize', 'capture', 'void', 'refund']);
export const FAKE_PAYPAL_FAULTS = Object.freeze([
  'authorize_denied', 'authorize_pending', 'capture_declined', 'capture_pending', 'refund_pending', 'refund_failed',
  'void_fail', 'auth_expire', 'order_not_approvable',
  ...['lost_response', 'timeout', 'http_500'].flatMap((f) => PAYPAL_CALLS.map((c) => `${f}:${c}`)),
]);
export const FAKE_MODEL_FAULTS = Object.freeze(['timeout', 'invalid_json', 'schema_invalid', 'error']);
export const FAULT_KINDS = Object.freeze([
  ['stock_depletion', 'Withdraw every offer of a supplier'],
  ['supplier_refusal', 'Make a supplier refuse its open orders'],
  ['refund_order', 'Refund a captured order'],
  ['fake_paypal', 'Simulated PayPal fault'],
  ['fake_model', 'Simulated AI fault'],
  ['clear', 'Clear all simulated faults'],
]);

// ---- pure builders ---------------------------------------------------------------------------------------------------

export function buildResetBody({ force = false, reason = '' } = {}) {
  const text = String(reason ?? '').trim();
  if (!force) return { ok: true, body: {}, error: null };
  if (text.length < 10 || text.length > 500) return { ok: false, body: null, error: 'A forced reset needs a reason of 10 to 500 characters.' };
  return { ok: true, body: { force: true, reason: text }, error: null };
}

function boundedCount(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') return { ok: true, value: undefined };
  if (/^\d{1,2}$/.test(text) && Number(text) >= 1 && Number(text) <= 10) return { ok: true, value: Number(text) };
  return { ok: false, value: undefined };
}

// values: { supplierCode, reason, supplierOrderId, fault, count } -> { ok, body, error }
export function buildFaultBody(kind, values = {}) {
  const fail = (error) => ({ ok: false, body: null, error });
  switch (kind) {
    case 'stock_depletion':
      return SUPPLIER_CODES.includes(values.supplierCode) ? { ok: true, body: { kind, supplierCode: values.supplierCode }, error: null } : fail('Choose a supplier.');
    case 'supplier_refusal': {
      if (!SUPPLIER_CODES.includes(values.supplierCode)) return fail('Choose a supplier.');
      const reason = String(values.reason ?? '').trim();
      return { ok: true, body: reason ? { kind, supplierCode: values.supplierCode, reason } : { kind, supplierCode: values.supplierCode }, error: null };
    }
    case 'refund_order': {
      const raw = String(values.supplierOrderId ?? '').trim();
      return /^\d{1,9}$/.test(raw) && Number(raw) >= 1 ? { ok: true, body: { kind, supplierOrderId: Number(raw) }, error: null } : fail('Enter the supplier order number.');
    }
    case 'fake_paypal': {
      if (!FAKE_PAYPAL_FAULTS.includes(values.fault)) return fail('Choose a fault.');
      const count = boundedCount(values.count);
      if (!count.ok) return fail('The number of repeats must be 1 to 10.');
      const body = { kind, fault: values.fault };
      if (SUPPLIER_CODES.includes(values.supplierCode)) body.supplierCode = values.supplierCode;
      if (count.value !== undefined) body.count = count.value;
      return { ok: true, body, error: null };
    }
    case 'fake_model': {
      if (!FAKE_MODEL_FAULTS.includes(values.fault)) return fail('Choose a fault.');
      const count = boundedCount(values.count);
      if (!count.ok) return fail('The number of repeats must be 1 to 10.');
      const body = { kind, fault: values.fault };
      if (count.value !== undefined) body.count = count.value;
      return { ok: true, body, error: null };
    }
    case 'clear':
      return { ok: true, body: { kind }, error: null };
    default:
      return fail('Choose what to do.');
  }
}

// Which controls of the fault form belong to a kind. The rest are hidden, so the form shows only what the call takes.
export const FAULT_FIELDS = Object.freeze({
  stock_depletion: ['supplier'],
  supplier_refusal: ['supplier', 'reason'],
  refund_order: ['order'],
  fake_paypal: ['paypalFault', 'supplier', 'count'],
  fake_model: ['modelFault', 'count'],
  clear: [],
});
export const faultFieldsFor = (kind) => (Object.hasOwn(FAULT_FIELDS, kind) ? FAULT_FIELDS[kind] : []);

const idList = (ids) => ids.join(', ');

// The sentence after a fault call came back 2xx. It says what the server reports and nothing more: a refund is
// "requested", never "returned" (the money moves only when PayPal confirms; the timeline shows it).
export function faultResultText(answer) {
  const a = answer?.applied ?? {};
  const replaced = Array.isArray(answer?.superseded) && answer.superseded.length > 0
    ? ` Plan versions replaced: ${idList(answer.superseded)}.` : '';
  switch (a.kind) {
    case 'stock_depletion': return `Every offer of supplier ${a.supplierCode} was withdrawn.${replaced}`;
    case 'supplier_refusal': {
      const ids = Array.isArray(a.supplierOrderIds) ? a.supplierOrderIds : [];
      return ids.length > 0
        ? `Supplier ${a.supplierCode} refused ${ids.length} open order${ids.length === 1 ? '' : 's'} (${idList(ids)}).${replaced}`
        : `Supplier ${a.supplierCode} had no open order to refuse.`;
    }
    case 'refund_order': return `A refund was requested for supplier order ${a.supplierOrderId}. It is not complete until PayPal confirms it; watch the timeline.`;
    case 'fake_paypal': return `Simulated PayPal fault ${a.fault}${a.supplierCode ? ` for supplier ${a.supplierCode}` : ''}${a.count ? `, ${a.count} time${a.count === 1 ? '' : 's'}` : ''} is set.`;
    case 'fake_model': return `Simulated AI fault ${a.fault}${a.count ? `, ${a.count} time${a.count === 1 ? '' : 's'}` : ''} is set.`;
    case 'clear': return 'All simulated faults were cleared.';
    default: return `Applied: ${a.kind ?? 'unknown'}.`;
  }
}

// POST /api/admin/reset 200 -> { text, stranded: [{ text }] }. A forced reset lists the operations it could not settle;
// they need a manual clean-up in the PayPal Sandbox dashboard, so the screen says so plainly.
export function resetResultModel(answer) {
  const stranded = (Array.isArray(answer?.stranded) ? answer.stranded : []).map((s) => ({
    text: [
      `Operation ${s.id}: ${s.status}`,
      s.providerAuthorizationId ? `authorization ${s.providerAuthorizationId}` : null,
      s.providerCaptureId ? `capture ${s.providerCaptureId}` : null,
    ].filter(Boolean).join(', '),
  }));
  return {
    text: `The demo was reset. ${answer?.archivedOperations ?? 0} payment operations were archived.`,
    strandedIntro: stranded.length > 0
      ? 'These payments are not finished. Check each one in the PayPal Sandbox dashboard and clean it up there by hand.'
      : null,
    stranded,
  };
}

export function buildTimelineViewModel(answer) {
  const rows = (answer.events ?? []).map((e) => ({
    cursor: e.cursor,
    atText: formatLocalDateTime(e.at),
    source: e.source,
    type: e.type,
    entity: `${e.entityType} #${e.entityId}`,
    detailText: JSON.stringify(e.detail ?? {}),
    testid: `timeline-row-${e.cursor}`,
  }));
  return { state: rows.length === 0 ? 'empty' : 'ready', rows, lastCursor: rows.length > 0 ? rows[rows.length - 1].cursor : null };
}

function countRows(counts) {
  return Object.entries(counts ?? {}).map(([group, byStatus]) => ({
    group,
    entries: Object.entries(byStatus ?? {}).map(([status, n]) => ({ status, n })),
  }));
}

export function buildMetricsViewModel(answer) {
  return {
    counts: countRows(answer.counts),
    reconciler: {
      lastTickText: answer.reconciler?.lastTickAt ? formatLocalDateTime(answer.reconciler.lastTickAt) : 'never',
      lastTickMs: answer.reconciler?.lastTickMs ?? null,
      unresolved: answer.reconciler?.unresolved ?? 0,
    },
    latency: Object.entries(answer.providerLatencyMs ?? {}).map(([kind, v]) => ({ kind, p50: v.p50, p95: v.p95, n: v.n })),
    model: { spent: answer.model?.spentTodayUsd ?? 0, budget: answer.model?.budgetUsd ?? 0 },
  };
}

const GROUP_TEXT = Object.freeze({ operationsByStatus: 'Payment operations', plansByStatus: 'Plan versions', reservationsByStatus: 'Reservations' });

// ---- DOM -------------------------------------------------------------------------------------------------------------

function resetDoneNode(model) {
  return noticeNode({
    text: model.text,
    tone: model.stranded.length > 0 ? 'warn' : 'ok',
    testid: 'reset-done',
    children: model.stranded.length > 0
      ? [el('p', { text: model.strandedIntro }), el('ul', { testid: 'reset-stranded' }, model.stranded.map((s) => el('li', { text: s.text })))]
      : [],
  });
}

function renderTimeline(model, on) {
  if (model.state === 'empty') return [emptyNode({ title: 'No events yet.', testid: 'timeline-empty' })];
  return [
    tableRegion('Timeline', el('table', { class: 'data-table', testid: 'timeline-table' }, [
      el('caption', { class: 'visually-hidden', text: 'Timeline of audit, ledger, provider and webhook events' }),
      el('thead', {}, [el('tr', {}, ['When (Amman)', 'Source', 'Event', 'About', 'Details'].map((t) => el('th', { scope: 'col', text: t })))]),
      el('tbody', {}, model.rows.map((r) => el('tr', { testid: r.testid }, [
        el('th', { scope: 'row', text: r.atText }),
        el('td', { text: r.source }),
        el('td', { text: r.type }),
        el('td', { text: r.entity }),
        el('td', { class: 'mono', text: r.detailText }),
      ]))),
    ])),
    el('button', { type: 'button', class: 'button', testid: 'timeline-more', on: { click: () => on.more(model.lastCursor) }, text: 'Show later events' }),
  ];
}

function renderMetrics(model) {
  return [
    ...model.counts.map((g) => el('div', { testid: `metrics-${g.group}` }, [
      el('h3', { text: GROUP_TEXT[g.group] ?? g.group }),
      g.entries.length === 0
        ? el('p', { class: 'muted', text: 'None.' })
        : el('ul', { class: 'plain-list' }, g.entries.map((e) => el('li', { text: `${e.status}: ${e.n}` }))),
    ])),
    el('div', { testid: 'metrics-reconciler' }, [
      el('h3', { text: 'Reconciler' }),
      el('p', { text: `Last run: ${model.reconciler.lastTickText}${model.reconciler.lastTickMs === null ? '' : ` (${model.reconciler.lastTickMs} ms)`}. Unresolved items: ${model.reconciler.unresolved}.` }),
    ]),
    el('div', { testid: 'metrics-latency' }, [
      el('h3', { text: 'Provider call latency (ms)' }),
      model.latency.length === 0
        ? el('p', { class: 'muted', text: 'No provider calls yet.' })
        : el('ul', { class: 'plain-list' }, model.latency.map((l) => el('li', { text: `${l.kind}: median ${l.p50}, 95th percentile ${l.p95}, ${l.n} calls` }))),
    ]),
    el('p', { testid: 'metrics-model', text: `AI spend today: $${model.model.spent} of a $${model.model.budget} daily budget.` }),
  ];
}

/** ctx: { api, container, announce, confirm } */
export function mountAdmin(ctx, route) {
  const title = el('h1', { id: 'page-title', tabindex: '-1', text: 'Admin' });
  const resetSlot = el('div', { testid: 'reset-slot' });
  const faultSlot = el('div', { testid: 'fault-slot' });
  const timelineSlot = el('div', { testid: 'timeline-slot' });
  const metricsSlot = el('div', { testid: 'metrics-slot' });
  replaceContent(ctx.container, [
    title,
    sectionEl('admin-reset', 'Reset the demo', [resetSlot]),
    sectionEl('admin-faults', 'Simulated faults', [faultSlot]),
    sectionEl('admin-timeline', 'Timeline', [timelineSlot]),
    sectionEl('admin-metrics', 'Metrics', [metricsSlot]),
  ]);
  let busy = false;
  let timelineRequestId = '';

  async function run(slot, workingText, task, okText) {
    if (busy) return;
    busy = true;
    replaceContent(slot, [loadingNode(workingText)]);
    ctx.announce(workingText);
    try {
      const answer = await task();
      ctx.announce(okText);
      return answer;
    } catch (err) {
      const d = describeError(err);
      ctx.announce(`${d.message} ${d.action}`);
      throw err;
    } finally {
      busy = false;
    }
  }

  // reset ---------------------------------------------------------------------------------------------------------
  function drawReset({ problem = null, result = null, error = null } = {}) {
    const force = checkboxField({
      id: 'reset-force',
      name: 'force',
      label: 'Force the reset even if a payment is in progress',
      hint: 'A forced reset first voids authorized payments and tries to settle unknown ones. Anything it cannot settle is listed afterwards.',
    });
    const reason = inputField({ id: 'reset-reason', name: 'reason', label: 'Reason (10 to 500 characters, needed to force)', type: 'textarea', rows: 3, required: false, maxlength: '500' });
    const blocked = error?.code === 'RESET_BLOCKED' && Array.isArray(error.details?.operations) ? error.details.operations : null;
    const form = el('form', {
      novalidate: true,
      'aria-label': 'Reset the demo',
      testid: 'reset-form',
      on: {
        submit: async (event) => {
          event.preventDefault();
          const built = buildResetBody({ force: force.input.checked, reason: reason.input.value });
          if (!built.ok) {
            drawReset({ problem: built.error });
            ctx.announce(built.error);
            return;
          }
          if (!ctx.confirm('Reset the demo data? Requests are archived and the catalog goes back to its starting values.')) return;
          try {
            const answer = await run(resetSlot, 'Resetting…', () => ctx.api.resetDemo(built.body), 'The demo was reset.');
            drawReset({ result: answer });
          } catch (err) {
            drawReset({ error: err });
          }
        },
      },
    }, [
      problem ? noticeNode({ text: problem, tone: 'warn', role: 'alert', testid: 'reset-problem' }) : null,
      error && !blocked ? errorNode(error) : null,
      blocked
        ? noticeNode({
          text: 'The demo cannot be reset while these payments are in progress. Wait for them, or force the reset with a reason.',
          tone: 'warn',
          role: 'alert',
          testid: 'reset-blocked',
          children: [el('ul', {}, blocked.map((o) => el('li', { text: `Operation ${o.id}: ${o.status}` })))],
        })
        : null,
      result ? resetDoneNode(resetResultModel(result)) : null,
      force.row,
      reason.row,
      submitButton('Reset the demo', { testid: 'reset-submit' }),
    ]);
    replaceContent(resetSlot, [form]);
  }

  // faults --------------------------------------------------------------------------------------------------------
  function drawFaults({ problem = null, result = null, error = null, kind = 'stock_depletion' } = {}) {
    const kindField = selectField({ id: 'fault-kind', name: 'kind', label: 'What to do', value: kind, options: FAULT_KINDS.map(([value, label]) => ({ value, label })) });
    const supplier = selectField({ id: 'fault-supplier', name: 'supplierCode', label: 'Supplier', value: '', options: [{ value: '', label: 'Any' }, ...SUPPLIER_CODES.map((c) => ({ value: c, label: `Supplier ${c}` }))] });
    const orderId = inputField({ id: 'fault-order', name: 'supplierOrderId', label: 'Supplier order number', type: 'number', required: false, min: '1', step: '1', inputmode: 'numeric' });
    const paypalFault = selectField({ id: 'fault-paypal', name: 'paypalFault', label: 'Simulated PayPal fault', options: [{ value: '', label: 'Choose…' }, ...FAKE_PAYPAL_FAULTS.map((f) => ({ value: f, label: f }))] });
    const modelFault = selectField({ id: 'fault-model', name: 'modelFault', label: 'Simulated AI fault', options: [{ value: '', label: 'Choose…' }, ...FAKE_MODEL_FAULTS.map((f) => ({ value: f, label: f }))] });
    const count = inputField({ id: 'fault-count', name: 'count', label: 'Repeats (1 to 10, optional)', type: 'number', required: false, min: '1', step: '1', inputmode: 'numeric' });
    const reason = inputField({ id: 'fault-reason', name: 'refusalReason', label: 'Refusal reason (optional, up to 300 characters)', required: false, maxlength: '300' });
    const form = el('form', {
      novalidate: true,
      'aria-label': 'Apply a simulated fault',
      testid: 'fault-form',
      on: {
        submit: async (event) => {
          event.preventDefault();
          const chosen = kindField.input.value;
          const built = buildFaultBody(chosen, {
            supplierCode: supplier.input.value,
            supplierOrderId: orderId.input.value,
            fault: chosen === 'fake_model' ? modelFault.input.value : paypalFault.input.value,
            count: count.input.value,
            reason: reason.input.value,
          });
          if (!built.ok) {
            drawFaults({ problem: built.error, kind: chosen });
            ctx.announce(built.error);
            return;
          }
          try {
            const answer = await run(faultSlot, 'Applying…', () => ctx.api.applyFault(built.body), 'The fault was applied.');
            drawFaults({ result: answer, kind: chosen });
          } catch (err) {
            drawFaults({ error: err, kind: chosen });
          }
        },
      },
    }, [
      problem ? noticeNode({ text: problem, tone: 'warn', role: 'alert', testid: 'fault-problem' }) : null,
      error ? errorNode(error) : null,
      result ? noticeNode({ text: faultResultText(result), tone: 'ok', testid: 'fault-done' }) : null,
      kindField.row,
      supplier.row,
      orderId.row,
      paypalFault.row,
      modelFault.row,
      count.row,
      reason.row,
      submitButton('Apply', { testid: 'fault-submit' }),
    ]);
    // Only the controls of the chosen kind are shown; the others are hidden (and ignored by buildFaultBody).
    const rows = { supplier: supplier.row, order: orderId.row, paypalFault: paypalFault.row, modelFault: modelFault.row, count: count.row, reason: reason.row };
    const showFor = (chosen) => {
      const wanted = faultFieldsFor(chosen);
      for (const [name, row] of Object.entries(rows)) {
        if (wanted.includes(name)) row.removeAttribute('hidden');
        else row.setAttribute('hidden', '');
      }
    };
    showFor(kind);
    kindField.input.addEventListener('change', () => showFor(kindField.input.value));
    replaceContent(faultSlot, [form]);
  }

  // timeline ------------------------------------------------------------------------------------------------------
  async function loadTimeline(afterId = null) {
    showState(timelineSlot, { kind: 'loading' });
    try {
      const answer = await ctx.api.getTimeline({ requestId: timelineRequestId, afterId });
      const model = buildTimelineViewModel(answer);
      const filter = inputField({ id: 'timeline-request', name: 'requestId', label: 'Show one request only (request number)', type: 'number', required: false, min: '1', step: '1', value: timelineRequestId, inputmode: 'numeric' });
      const form = el('form', {
        novalidate: true,
        'aria-label': 'Filter the timeline',
        on: { submit: (event) => { event.preventDefault(); timelineRequestId = filter.input.value.trim(); loadTimeline(); } },
      }, [filter.row, submitButton('Filter', { testid: 'timeline-filter' })]);
      showState(timelineSlot, { kind: 'ready', nodes: [form, ...renderTimeline(model, { more: (cursor) => loadTimeline(cursor) })] });
      ctx.announce(model.state === 'empty' ? 'No events.' : `${model.rows.length} events loaded.`);
    } catch (err) {
      showState(timelineSlot, { kind: 'error', error: err, onRetry: () => loadTimeline(afterId) });
    }
  }

  // metrics -------------------------------------------------------------------------------------------------------
  async function loadMetrics() {
    showState(metricsSlot, { kind: 'loading' });
    try {
      showState(metricsSlot, { kind: 'ready', nodes: renderMetrics(buildMetricsViewModel(await ctx.api.getMetrics())) });
    } catch (err) {
      showState(metricsSlot, { kind: 'error', error: err, onRetry: loadMetrics });
    }
  }

  drawReset();
  drawFaults();
  loadTimeline();
  loadMetrics();
  return { dispose() {} };
}

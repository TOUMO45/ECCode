// #/requests/:id — the request page. It answers the six questions of RS-35 in order: requirements with
// provenance, the planner's decision trace, rejections, totals in server cents, catalog offer next to the supplier's
// commitment, and compensation state with the next step. buildRequestViewModel is pure (RequestView in, plain
// objects out); renderRequestPage builds DOM from it; mountRequestDetail loads, polls and wires the actions.

import { el, replaceContent } from '../dom.js';
import { SECTION_TITLES } from '../texts.js';
import { isNavigableUrl, utcToLocal } from '../format.js';
import { describeError, fieldErrorMap } from '../errors.js';
import { getReserveKey } from '../reserve-key.js';
import { createPoller } from '../poll.js';
import { statusModel, renderStatus } from '../components/status.js';
import { needModel, renderNeed, buildConfirmBody, valuesFromFields } from '../components/fields-table.js';
import { whyModel, renderWhy } from '../components/plan-card.js';
import { rejectedModel, renderRejected } from '../components/rejections.js';
import { totalModel, renderTotal } from '../components/totals.js';
import { commitmentsModel, renderCommitments } from '../components/commitments.js';
import { failureModel, renderFailure } from '../components/compensation.js';
import { actionsModel, renderActions } from '../components/payments.js';
import { errorNode, loadingNode, noticeNode, sectionEl, showState } from '../components/notice.js';
import { supplierDirectory } from '../view-helpers.js';

export const SECTION_ORDER = Object.freeze(['status', 'need', 'why', 'rejected', 'total', 'commitments', 'failure', 'actions']);

// ?paypal=returned|cancelled&order=<id> after the buyer comes back from the approval page.
export function returnNoticeModel(query, view) {
  const outcome = query?.paypal;
  if (outcome !== 'returned' && outcome !== 'cancelled') return null;
  const orderId = Number(query.order);
  const order = [...(view.orders ?? []), ...(view.cancellingOrders ?? [])].find((o) => o.id === orderId);
  const name = order ? (supplierDirectory(view).get(order.supplier.code)?.name ?? `Supplier ${order.supplier.code}`) : 'the supplier';
  if (outcome === 'returned') {
    return { tone: 'info', text: `You are back from PayPal for ${name}. Waiting for PayPal to confirm; this page updates by itself.`, testid: 'paypal-returned' };
  }
  return { tone: 'warn', text: `The PayPal approval for ${name} was cancelled. Nothing was paid. Try approval again or abandon the purchase.`, testid: 'paypal-cancelled' };
}

export function buildRequestViewModel(view, { query = {} } = {}) {
  const sections = [
    { id: 'status', heading: 'Status', model: statusModel(view) },
    { id: 'need', heading: SECTION_TITLES.need, model: needModel(view) },
    { id: 'why', heading: SECTION_TITLES.why, model: whyModel(view) },
    { id: 'rejected', heading: SECTION_TITLES.rejected, model: rejectedModel(view) },
    { id: 'total', heading: SECTION_TITLES.total, model: totalModel(view) },
    { id: 'commitments', heading: SECTION_TITLES.commitments, model: commitmentsModel(view) },
    { id: 'failure', heading: SECTION_TITLES.failure, model: failureModel(view) },
    { id: 'actions', heading: SECTION_TITLES.actions, model: actionsModel(view) },
  ];
  return {
    requestId: view.request.id,
    heading: `Rescue request #${view.request.id}`,
    rawText: view.request.rawText ?? null,
    returnNotice: returnNoticeModel(query, view),
    sections,
    sectionOrder: sections.map((s) => s.id),
  };
}

// The confirm body for a relaxation button: every current value, with the relaxed constraint changed.
export function applyRelaxation(requirementFields, relaxation) {
  const values = valuesFromFields(requirementFields);
  switch (relaxation.constraint) {
    case 'budget': values.budgetCents = relaxation.neededValue; break;
    case 'deadline': values.deadline = utcToLocal(relaxation.neededValue); break;
    case 'maxPickups': values.maxPickups = relaxation.neededValue; break;
    default: throw new RangeError('unknown relaxation constraint');
  }
  return { fields: values };
}

// ---- DOM ------------------------------------------------------------------------------------------------------------

export function renderRequestPage(vm, on = {}, formErrors = {}) {
  const parts = [];
  if (vm.returnNotice) parts.push(noticeNode({ text: vm.returnNotice.text, tone: vm.returnNotice.tone, testid: vm.returnNotice.testid }));
  if (vm.rawText) {
    parts.push(el('details', { class: 'raw-text' }, [el('summary', { text: 'Your original request' }), el('p', { dir: 'auto', testid: 'raw-text', text: vm.rawText })]));
  }
  // The header button starts the same action as the button in the Actions section, with the same data.
  const actions = vm.sections.find((s) => s.id === 'actions')?.model ?? {};
  const headerOn = {
    plan: on.plan,
    replan: on.replan,
    approve: actions.approve && !actions.approve.blockedReason && on.approve ? () => on.approve(actions.approve) : null,
    reserve: actions.reserve && on.reserve ? () => on.reserve(actions.reserve) : null,
    execute: actions.execute && on.execute ? () => on.execute(actions.execute) : null,
  };
  const renderers = {
    status: (m) => renderStatus(m, headerOn),
    need: (m) => renderNeed(m, on, formErrors),
    why: (m) => renderWhy(m),
    rejected: (m) => renderRejected(m, on),
    total: (m) => renderTotal(m),
    commitments: (m) => renderCommitments(m),
    failure: (m) => renderFailure(m),
    actions: (m) => renderActions(m, on),
  };
  for (const s of vm.sections) parts.push(sectionEl(s.id, s.heading, renderers[s.id](s.model)));
  return el('div', { class: 'request-page', testid: 'request-page' }, parts);
}

// ---- the page --------------------------------------------------------------------------------------------------------

function isEditing(doc) {
  const tag = doc?.activeElement?.tagName;
  return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
}

/**
 * ctx: { api, container, storage, announce, navigate, assignLocation, confirm, document }
 * Returns { dispose() }.
 */
export function mountRequestDetail(ctx, route) {
  const id = route.params.id;
  const doc = ctx.document ?? globalThis.document;
  const title = el('h1', { id: 'page-title', tabindex: '-1', text: `Rescue request #${id}` });
  const slot = el('div', { id: 'request-slot', testid: 'request-slot' });
  const feedback = el('div', { id: 'request-feedback' });
  replaceContent(ctx.container, [title, feedback, slot]);

  let view = null;
  let lastKey = null;
  let lastSummary = null;
  let formErrors = {};
  let busy = false;
  let disposed = false;

  const poller = createPoller({
    load: () => ctx.api.getRequest(id),
    onData: (data) => {
      if (disposed) return;
      show(data, { fromPoll: true });
    },
    onError: () => {},
  });

  function summaryOf(data) {
    return `${data.rescueStatus.status}|${data.rescueStatus.nextStep.text}`;
  }

  function show(data, { fromPoll = false } = {}) {
    const key = JSON.stringify({ ...data, requestId: null });
    if (fromPoll && key === lastKey) return;
    if (fromPoll && isEditing(doc)) return; // do not wipe what the user is typing; the next poll draws it
    const changedStatus = lastSummary !== null && lastSummary !== summaryOf(data);
    view = data;
    lastKey = key;
    lastSummary = summaryOf(data);
    draw();
    if (changedStatus) ctx.announce(`Status: ${data.rescueStatus.status.replace(/_/g, ' ')}. Next step: ${data.rescueStatus.nextStep.text}`);
  }

  function draw() {
    const focusedTestId = doc?.activeElement?.getAttribute?.('data-testid') ?? null;
    const vm = buildRequestViewModel(view, { query: route.query });
    showState(slot, { kind: 'ready', nodes: [renderRequestPage(vm, handlers, formErrors)] });
    if (focusedTestId && slot.querySelectorAll) {
      // Keep keyboard focus on the same control after the page is drawn again.
      const same = Array.from(slot.querySelectorAll('[data-testid]')).find((n) => n.getAttribute('data-testid') === focusedTestId);
      same?.focus?.();
    }
  }

  async function reload() {
    const data = await ctx.api.getRequest(id);
    formErrors = {};
    show(data);
    poller.stop();
    poller.start(data);
  }

  async function load() {
    showState(slot, { kind: 'loading' });
    try {
      await reload();
    } catch (err) {
      showState(slot, { kind: 'error', error: err, onRetry: load });
      ctx.announce(describeError(err).message);
    }
  }

  // Runs one user action; shows its error above the page; reloads the view afterwards.
  async function perform(workingText, task, { reloadAfter = true } = {}) {
    if (busy) return;
    busy = true;
    replaceContent(feedback, [loadingNode(workingText)]);
    ctx.announce(workingText);
    try {
      await task();
      replaceContent(feedback, []);
      if (reloadAfter) await reload();
    } catch (err) {
      const d = describeError(err);
      replaceContent(feedback, [errorNode(err, { onRetry: d.retryable ? () => load() : null })]);
      ctx.announce(`${d.message} ${d.action}`);
      // After a refused step (a changed plan, a lost race) the page shows what is true now.
      if (d.code !== 'CLIENT_TIMEOUT' && d.code !== 'NETWORK_ERROR') {
        try { await reload(); } catch { /* the error above stays */ }
      }
      if (d.fields.length > 0 && view) {
        formErrors = fieldErrorMap(d);
        draw();
      }
    } finally {
      busy = false;
    }
  }

  const planNow = () => ctx.api.planRequest(id);

  const handlers = {
    plan: () => perform('Looking for a plan…', planNow),
    replan: () => perform('Looking for a plan…', planNow),
    approve: (spec) => perform('Approving the plan…', () => ctx.api.approvePlan(spec.planId, spec.expectedTotalCents, spec.planHash)),
    reserve: (spec) => perform('Reserving the stock…', () => {
      // The key is made once per plan version and reused on every retry and after a refresh (RS-16).
      const key = getReserveKey(ctx.storage, spec.planId);
      return ctx.api.reservePlan(spec.planId, key);
    }),
    paypal: (p) => perform('Opening PayPal…', async () => {
      const answer = await ctx.api.createPayPalOrder(p.orderId);
      if (!isNavigableUrl(answer.approvalUrl)) throw Object.assign(new Error('PayPal sent no usable approval link.'), { code: 'PROVIDER_ERROR' });
      ctx.assignLocation(answer.approvalUrl);
    }, { reloadAfter: false }),
    execute: (spec) => perform('Completing the purchase…', () => ctx.api.executePlan(spec.planId)),
    abandon: (spec) => perform('Abandoning the purchase…', () => ctx.api.abandonPlan(spec.planId)),
    receipt: (spec) => perform('Recording your receipt…', () => ctx.api.recordReceipt(spec.orderId)),
    remove: () => {
      if (!ctx.confirm('Delete this request? This cannot be undone.')) return;
      perform('Deleting the request…', async () => {
        await ctx.api.deleteRequest(id);
        ctx.navigate('#/requests');
      }, { reloadAfter: false });
    },
    confirm: (values) => {
      const built = buildConfirmBody(values);
      if (!built.ok) {
        formErrors = Object.fromEntries(built.errors.map((e) => [e.field, e.message]));
        draw();
        ctx.announce(`${built.errors.length} detail${built.errors.length === 1 ? '' : 's'} need fixing.`);
        return;
      }
      perform('Saving your details…', async () => {
        await ctx.api.confirmRequest(id, built.fields);
        await planNow();
      });
    },
    relax: (relaxation) => perform('Applying the change…', async () => {
      const body = applyRelaxation(view.requirements?.fields, relaxation);
      await ctx.api.confirmRequest(id, body.fields);
      await planNow();
    }),
  };

  const onVisible = () => {
    if (doc && !doc.hidden) poller.resume();
  };
  doc?.addEventListener?.('visibilitychange', onVisible);

  load();

  return {
    dispose() {
      disposed = true;
      poller.stop();
      doc?.removeEventListener?.('visibilitychange', onVisible);
    },
  };
}

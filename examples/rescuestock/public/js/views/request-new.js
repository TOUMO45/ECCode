// #/requests/new — describe what you need (Arabic or English), optionally add a package photo, then: create the
// request, upload the photo, ask for an extraction, open the request page. The request page shows the result
// ("What you need": value, provenance badge, original wording, questions, or the degraded notice and manual form).
//
// This screen owns the states before that page: idle, creating, uploading (with the file's name and size, and a Cancel),
// extracting (with a Cancel), error (with Retry) and cancelled. The request and the photo are created once; a Retry
// continues from the step that failed instead of making a second request.

import { el, replaceContent } from '../dom.js';
import { describeError } from '../errors.js';
import { formatBytes } from '../format.js';
import { requestHash } from '../router.js';
import { fileField, inputField, submitButton } from '../components/form.js';
import { errorNode, noticeNode } from '../components/notice.js';

export const MAX_TEXT_LENGTH = 4000;
// The server's cap is 5,242,880 bytes (413) and it accepts PNG, JPEG and WebP only (415). These checks are for the
// user's convenience: the server checks the declared type, the magic bytes and the size again.
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const IMAGE_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp']);
export const IMAGE_ACCEPT = IMAGE_TYPES.join(',');

export function validateRequestText(text) {
  const value = String(text ?? '');
  if (value.trim().length === 0) return 'Describe what you need before you send.';
  if (value.length > MAX_TEXT_LENGTH) return `Use at most ${MAX_TEXT_LENGTH} characters.`;
  return null;
}

// file: { name, type, size } (a File), or null when no photo is chosen. Returns a message or null.
export function validateImageFile(file) {
  if (file === null || file === undefined) return null;
  if (!IMAGE_TYPES.includes(file.type)) return 'Choose a PNG, JPEG or WebP photo.';
  if (!Number.isSafeInteger(file.size) || file.size <= 0) return 'That file is empty. Choose another photo.';
  if (file.size > MAX_IMAGE_BYTES) return `That photo is ${formatBytes(file.size)}. The limit is ${formatBytes(MAX_IMAGE_BYTES)}. Choose a smaller photo.`;
  return null;
}

/**
 * What to do when an extract call fails.
 *   cancelled  the user used Cancel
 *   open       open the request page: the server stored a degraded extraction (429 with details.degraded, 503)
 *   retry      anything else, a 404 included: show the error with a Retry button
 */
export function classifyExtractFailure(err) {
  if (err?.code === 'CLIENT_CANCELLED') return { kind: 'cancelled' };
  // MODEL_BUDGET_EXHAUSTED (503) and the extract_upload RATE_LIMITED (429) store a degraded extraction and carry it
  // in details; the request page shows the notice and the manual form.
  if (err?.code === 'MODEL_BUDGET_EXHAUSTED' || (err?.status === 429 && err?.details?.degraded === true)) return { kind: 'open', reason: 'degraded' };
  return { kind: 'retry' };
}

// The progress states as plain data (the view draws them). `fileName` and `fileSize` describe the chosen photo.
export function progressModel(state, { fileName = null, fileSize = null } = {}) {
  switch (state) {
    case 'creating':
      return { state, text: 'Sending your request…', cancellable: false, indeterminate: true };
    case 'uploading':
      return {
        state,
        text: `Uploading ${fileName ?? 'the photo'}${Number.isSafeInteger(fileSize) ? ` (${formatBytes(fileSize)})` : ''}…`,
        cancellable: true,
        indeterminate: true,
      };
    case 'extracting':
      return { state, text: 'Reading your request…', cancellable: true, indeterminate: true };
    case 'done':
      return { state, text: 'Details read. Opening your request…', cancellable: false, indeterminate: false };
    default:
      return null;
  }
}

function renderProgress(model, { onCancel }) {
  return el('div', { class: 'state state-loading', role: 'status', 'aria-busy': model.state === 'done' ? null : 'true', testid: `extraction-${model.state}` }, [
    el('p', { class: 'state-title', text: model.text }),
    model.state === 'done' ? null : el('progress', { 'aria-label': model.text, testid: 'extraction-progress' }),
    model.cancellable
      ? el('button', { type: 'button', class: 'button', testid: 'extraction-cancel', on: { click: onCancel }, text: 'Cancel' })
      : null,
  ]);
}

/** ctx: { api, container, announce, navigate } */
export function mountRequestNew(ctx, route) {
  const title = el('h1', { id: 'page-title', tabindex: '-1', text: 'New rescue request' });
  const textSlot = el('div', {});
  const imageSlot = el('div', {});
  const stateSlot = el('div', { testid: 'extraction-state' });
  const submit = submitButton('Send request', { testid: 'request-new-submit' });
  const form = el('form', {
    class: 'form',
    novalidate: true,
    'aria-label': 'New rescue request',
    testid: 'request-new-form',
    on: { submit: onSubmit },
  }, [textSlot, imageSlot, submit]);
  replaceContent(ctx.container, [title, form, stateSlot]);

  let textInput = null;
  let imageInput = null;
  let busy = false;
  let disposed = false;
  let requestId = null; // set once the request exists; a Retry never creates a second one
  let createdText = null;
  let uploadedFile = null; // the File already uploaded for this request
  let pendingText = '';
  let controller = null;

  function drawText(text = '', error = null) {
    const field = inputField({
      id: 'request-text',
      name: 'text',
      label: 'Describe what you need, in Arabic or English',
      type: 'textarea',
      value: text,
      dir: 'auto',
      rows: 6,
      maxlength: String(MAX_TEXT_LENGTH),
      hint: 'For example: 200 cups and 200 lids, 250 ml, by 11:00 today, budget $120, at most 2 pickups.',
      error,
    });
    textInput = field.input;
    replaceContent(textSlot, [field.row]);
  }

  function drawImage(error = null) {
    const field = fileField({
      id: 'request-image',
      name: 'image',
      label: 'Photo of the package (optional)',
      accept: IMAGE_ACCEPT,
      hint: 'PNG, JPEG or WebP, up to 5 MB. The photo helps us read sizes printed on the package.',
      error,
    });
    field.input.addEventListener('change', onImageChange);
    imageInput = field.input;
    replaceContent(imageSlot, [field.row]);
  }

  const chosenFile = () => imageInput?.files?.[0] ?? null;

  function onImageChange() {
    const problem = validateImageFile(chosenFile());
    if (problem) {
      drawImage(problem); // the invalid choice is dropped; the user picks another photo
      ctx.announce(problem);
    }
  }

  function showState(nodes) {
    replaceContent(stateSlot, nodes);
  }

  function showProgress(state, file) {
    const model = progressModel(state, { fileName: file?.name ?? null, fileSize: file?.size ?? null });
    showState([renderProgress(model, { onCancel: () => controller?.abort() })]);
    ctx.announce(model.text);
  }

  // Once the request exists the user can always leave for its page and enter the details by hand.
  const openLink = () => el('a', { class: 'button', href: requestHash(requestId), testid: 'extraction-open', text: 'Open the request and enter the details by hand' });

  function showError(err) {
    const d = describeError(err);
    showState([errorNode(err, { onRetry: () => run() }), requestId === null ? null : openLink()]);
    ctx.announce(`${d.message} ${d.action}`);
  }

  function showCancelled() {
    showState([
      noticeNode({ text: 'You cancelled. Your request was saved; nothing else was changed.', tone: 'warn', testid: 'extraction-cancelled' }),
      el('button', { type: 'button', class: 'button button-primary', testid: 'extraction-retry', on: { click: () => run() }, text: 'Try again' }),
      openLink(),
    ]);
    ctx.announce('You cancelled. Your request was saved.');
  }

  // Create (once), upload (once per chosen photo), extract. Each step can fail and be retried alone.
  async function run() {
    if (busy || disposed) return;
    busy = true;
    const file = chosenFile();
    controller = new AbortController();
    const { signal } = controller;
    let step = 'creating';
    try {
      if (requestId !== null && createdText !== pendingText) {
        // The text changed after the request was saved: this is a new request (the earlier draft stays in the list).
        requestId = null;
        uploadedFile = null;
      }
      if (requestId === null) {
        showProgress('creating', file);
        const created = await ctx.api.createRequest(pendingText);
        requestId = created.request.id;
        createdText = pendingText;
      }
      if (file && uploadedFile !== file) {
        step = 'uploading';
        showProgress('uploading', file);
        await ctx.api.uploadRequestImage(requestId, file, { signal });
        uploadedFile = file;
      }
      step = 'extracting';
      showProgress('extracting', file);
      await ctx.api.extractRequest(requestId, { signal });
      if (disposed) return;
      showState([renderProgress(progressModel('done'), { onCancel: () => {} })]);
      ctx.announce(progressModel('done').text);
      ctx.navigate(requestHash(requestId));
    } catch (err) {
      if (disposed) return;
      if (step === 'creating') {
        showError(err); // nothing was created; the form still holds the text and Retry sends it again
        return;
      }
      const verdict = step === 'extracting' ? classifyExtractFailure(err) : classifyUploadFailure(err);
      if (verdict.kind === 'cancelled') showCancelled();
      else if (verdict.kind === 'open') ctx.navigate(requestHash(requestId));
      else showError(err);
    } finally {
      busy = false;
      controller = null;
    }
  }

  function classifyUploadFailure(err) {
    if (err?.code === 'CLIENT_CANCELLED') return { kind: 'cancelled' };
    return { kind: 'retry' };
  }

  async function onSubmit(event) {
    event.preventDefault();
    if (busy) return;
    const text = textInput.value;
    const textProblem = validateRequestText(text);
    const file = chosenFile();
    const imageProblem = validateImageFile(file);
    if (textProblem || imageProblem) {
      if (textProblem) drawText(text, textProblem);
      if (imageProblem) drawImage(imageProblem);
      showState([]);
      ctx.announce([textProblem, imageProblem].filter(Boolean).join(' '));
      return;
    }
    pendingText = text;
    await run();
  }

  drawText();
  drawImage();
  return {
    dispose() {
      disposed = true;
      controller?.abort();
    },
  };
}

// #/requests/new — text only in this phase: create the request, ask for an extraction, open the request page.
// The extraction is allowed to fail: the request page then offers the manual form (degraded state).

import { el, replaceContent } from '../dom.js';
import { describeError } from '../errors.js';
import { requestHash } from '../router.js';
import { inputField, submitButton } from '../components/form.js';
import { errorNode, loadingNode } from '../components/notice.js';

export const MAX_TEXT_LENGTH = 4000;

export function validateRequestText(text) {
  const value = String(text ?? '');
  if (value.trim().length === 0) return 'Describe what you need before you send.';
  if (value.length > MAX_TEXT_LENGTH) return `Use at most ${MAX_TEXT_LENGTH} characters.`;
  return null;
}

/** ctx: { api, container, announce, navigate } */
export function mountRequestNew(ctx, route) {
  const title = el('h1', { id: 'page-title', tabindex: '-1', text: 'New rescue request' });
  const body = el('div', {});
  replaceContent(ctx.container, [title, body]);
  let busy = false;

  function draw({ text = '', error = null, serverError = null } = {}) {
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
    const form = el('form', {
      class: 'form',
      novalidate: true,
      'aria-label': 'New rescue request',
      testid: 'request-new-form',
      on: {
        submit: async (event) => {
          event.preventDefault();
          if (busy) return;
          const value = field.input.value;
          const problem = validateRequestText(value);
          if (problem) {
            draw({ text: value, error: problem });
            ctx.announce(problem);
            return;
          }
          busy = true;
          replaceContent(body, [loadingNode('Sending your request…')]);
          ctx.announce('Sending your request…');
          try {
            const created = await ctx.api.createRequest(value);
            const id = created.request.id;
            try {
              await ctx.api.extractRequest(id);
            } catch {
              // The request page shows the manual form when the details were not read.
            }
            ctx.navigate(requestHash(id));
          } catch (err) {
            draw({ text: value, serverError: err });
            ctx.announce(describeError(err).message);
          } finally {
            busy = false;
          }
        },
      },
    }, [
      serverError ? errorNode(serverError) : null,
      field.row,
      submitButton('Send request', { testid: 'request-new-submit' }),
    ]);
    replaceContent(body, [form]);
  }

  draw();
  return { dispose() {} };
}

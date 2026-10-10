// #/signin — sign-in form. Client checks are for convenience; the server decides.

import { el, replaceContent } from '../dom.js';
import { describeError } from '../errors.js';
import { inputField, submitButton } from '../components/form.js';
import { errorNode } from '../components/notice.js';

export function validateSignIn(values) {
  const errors = {};
  if (String(values.username ?? '').trim() === '') errors.username = 'Enter your username.';
  if (String(values.password ?? '') === '') errors.password = 'Enter your password.';
  return errors;
}

/** ctx: { api, container, announce, onSignedIn(user) } */
export function mountSignIn(ctx, route) {
  const title = el('h1', { id: 'page-title', tabindex: '-1', text: 'Sign in' });
  const body = el('div', {});
  replaceContent(ctx.container, [title, body]);
  let busy = false;

  function draw({ values = { username: '', password: '' }, errors = {}, serverError = null } = {}) {
    const username = inputField({ id: 'signin-username', name: 'username', label: 'Username', value: values.username, autocomplete: 'username', error: errors.username });
    const password = inputField({ id: 'signin-password', name: 'password', label: 'Password', type: 'password', value: '', autocomplete: 'current-password', error: errors.password });
    const form = el('form', {
      class: 'form',
      novalidate: true,
      'aria-label': 'Sign in',
      testid: 'signin-form',
      on: {
        submit: async (event) => {
          event.preventDefault();
          if (busy) return;
          const next = { username: username.input.value, password: password.input.value };
          const found = validateSignIn(next);
          if (Object.keys(found).length > 0) {
            draw({ values: next, errors: found });
            ctx.announce('Fix the marked fields and sign in again.');
            return;
          }
          busy = true;
          ctx.announce('Signing in…');
          try {
            const answer = await ctx.api.signIn(next.username.trim(), next.password);
            ctx.api.setCsrfToken(answer.csrfToken);
            ctx.onSignedIn(answer.user);
          } catch (err) {
            draw({ values: { username: next.username, password: '' }, serverError: err });
            ctx.announce(describeError(err).message);
          } finally {
            busy = false;
          }
        },
      },
    }, [
      serverError ? errorNode(serverError) : null,
      username.row,
      password.row,
      submitButton('Sign in', { testid: 'signin-submit' }),
    ]);
    replaceContent(body, [form, el('p', {}, ['No account yet? ', el('a', { href: '#/register', text: 'Create an account' }), '.'])]);
  }

  draw();
  return { dispose() {} };
}

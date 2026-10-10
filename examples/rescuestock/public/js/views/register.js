// #/register — creates a customer account (the server always assigns the customer role).

import { el, replaceContent } from '../dom.js';
import { describeError, fieldErrorMap } from '../errors.js';
import { inputField, submitButton } from '../components/form.js';
import { errorNode } from '../components/notice.js';

export function validateRegister(values) {
  const errors = {};
  const username = String(values.username ?? '').trim();
  if (!/^[A-Za-z0-9_.-]{3,40}$/.test(username)) errors.username = 'Use 3 to 40 letters, digits, dots, dashes or underscores.';
  const password = String(values.password ?? '');
  if (password.length < 10 || password.length > 200) errors.password = 'Use 10 to 200 characters.';
  const displayName = String(values.displayName ?? '').trim();
  if (displayName.length < 1 || displayName.length > 80) errors.displayName = 'Enter a name of 1 to 80 characters.';
  return errors;
}

/** ctx: { api, container, announce, onSignedIn(user), config } */
export function mountRegister(ctx, route) {
  const title = el('h1', { id: 'page-title', tabindex: '-1', text: 'Create an account' });
  const body = el('div', {});
  replaceContent(ctx.container, [title, body]);
  let busy = false;

  function draw({ values = { username: '', displayName: '' }, errors = {}, serverError = null } = {}) {
    const username = inputField({ id: 'register-username', name: 'username', label: 'Username', value: values.username, autocomplete: 'username', hint: '3 to 40 letters, digits, dots, dashes or underscores.', error: errors.username });
    const displayName = inputField({ id: 'register-display-name', name: 'displayName', label: 'Your name or business name', value: values.displayName, autocomplete: 'name', maxlength: '80', error: errors.displayName });
    const password = inputField({ id: 'register-password', name: 'password', label: 'Password', type: 'password', autocomplete: 'new-password', hint: 'At least 10 characters.', error: errors.password });
    const form = el('form', {
      class: 'form',
      novalidate: true,
      'aria-label': 'Create an account',
      testid: 'register-form',
      on: {
        submit: async (event) => {
          event.preventDefault();
          if (busy) return;
          const next = { username: username.input.value, displayName: displayName.input.value, password: password.input.value };
          const found = validateRegister(next);
          if (Object.keys(found).length > 0) {
            draw({ values: next, errors: found });
            ctx.announce('Fix the marked fields and send again.');
            return;
          }
          busy = true;
          ctx.announce('Creating your account…');
          try {
            const answer = await ctx.api.register(next.username.trim(), next.password, next.displayName.trim());
            ctx.api.setCsrfToken(answer.csrfToken);
            ctx.onSignedIn(answer.user);
          } catch (err) {
            const d = describeError(err);
            const fieldErrors = fieldErrorMap(d);
            draw({
              values: { username: next.username, displayName: next.displayName },
              errors: err.code === 'USERNAME_TAKEN' ? { username: 'That username is taken. Choose another one.' } : fieldErrors,
              serverError: err.code === 'USERNAME_TAKEN' ? null : err,
            });
            ctx.announce(d.message);
          } finally {
            busy = false;
          }
        },
      },
    }, [
      serverError ? errorNode(serverError) : null,
      username.row,
      displayName.row,
      password.row,
      submitButton('Create account', { testid: 'register-submit' }),
    ]);
    replaceContent(body, [form, el('p', {}, ['Already have an account? ', el('a', { href: '#/signin', text: 'Sign in' }), '.'])]);
  }

  if (ctx.config && ctx.config.signupEnabled === false) {
    replaceContent(body, [el('p', { role: 'status', testid: 'signup-disabled', text: 'Registration is turned off. Ask the organiser for an account, or sign in.' }), el('p', {}, [el('a', { href: '#/signin', text: 'Sign in' })])]);
  } else {
    draw();
  }
  return { dispose() {} };
}

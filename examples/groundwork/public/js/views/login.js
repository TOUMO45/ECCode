import { api, describeError } from '../api.js';
import { setCsrfToken } from '../api.js';
import { h, focusHeading } from '../dom.js';

export function loginView(root, app) {
  const user = h('input', { id: 'login-username', name: 'username', type: 'text', autocomplete: 'username', required: true, testid: 'login-username', 'aria-describedby': 'login-error' });
  const pass = h('input', { id: 'login-password', name: 'password', type: 'password', autocomplete: 'current-password', required: true, testid: 'login-password', 'aria-describedby': 'login-error' });
  const err = h('p', { id: 'login-error', class: 'error-text', role: 'alert', testid: 'login-error' });
  const btn = h('button', { type: 'submit', testid: 'login-submit' }, 'Sign in');
  const form = h('form', { class: 'card form-narrow', novalidate: true, 'aria-labelledby': 'login-h' },
    h('label', { for: 'login-username' }, 'Username'), user,
    h('label', { for: 'login-password' }, 'Password'), pass,
    err, h('div', { class: 'row' }, btn));

  const busy = (b) => {
    for (const el of [user, pass, btn]) el.disabled = b;
    form.setAttribute('aria-busy', String(b));
    btn.textContent = b ? 'Signing in...' : 'Sign in';
  };
  const fail = (msg) => {
    err.textContent = msg;
    for (const el of [user, pass]) el.setAttribute('aria-invalid', 'true');
  };

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    err.textContent = '';
    for (const el of [user, pass]) el.removeAttribute('aria-invalid');
    if (!user.value.trim() || !pass.value) { fail('Enter your username and password.'); (user.value.trim() ? pass : user).focus(); return; }
    busy(true);
    try {
      const c = await api.csrf(); // pre-login token for the double-submit check
      setCsrfToken(c.csrfToken);
      const res = await api.login(user.value.trim(), pass.value);
      pass.value = '';
      app.setSession(res.user, res.csrfToken);
      app.navigate(app.home());
    } catch (e) {
      busy(false);
      fail(e.code === 'INVALID_CREDENTIALS' ? 'Invalid username or password. Check them and try again.' : describeError(e));
      pass.value = '';
      pass.focus();
    }
  });

  root.append(h('h1', { id: 'login-h', text: 'Sign in' }), form);
  focusHeading(root);
  return null;
}

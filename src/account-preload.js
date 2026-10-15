// Runs in every ACCOUNT view (isolated world, sandboxed). It exposes NOTHING to the page.
// Purpose: remember logins you type so you can sign back in later, and fill them on request.
const { ipcRenderer } = require('electron');

function visible(el) {
  return el && !el.disabled && !el.readOnly && el.offsetParent !== null;
}

const USER_SEL = [
  'input[autocomplete=username]', 'input[type=email]',
  'input[name*=user i]', 'input[id*=user i]', 'input[name*=email i]', 'input[id*=email i]',
  'input[type=text]',
].join(',');

function findFields(root = document) {
  const pw = [...root.querySelectorAll('input[type=password]')].filter(visible)[0] || null;
  let user = null;
  if (pw && pw.form) user = [...pw.form.querySelectorAll(USER_SEL)].filter(visible).pop() || null;
  if (!user) user = [...root.querySelectorAll(USER_SEL)].filter(visible)[0] || null;
  return { user, pw };
}

function setValue(el, v) {
  if (!el) return false;
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

// ---- capture: report credentials the user actually submits ----
// A real sign-in only: the password field must sit in the form being submitted (or be the focused
// field). Enter in an unrelated box or a click on some other button must not capture a stray
// password — change-password forms and settings pages keep their fields out of this path.
function capture(e) {
  const { user, pw } = findFields();
  if (!pw || !pw.value) return;
  if (pw.form) {
    const t = e && e.target;
    const inForm = t === pw.form || (t && t.nodeType === 1 && pw.form.contains(t));
    const focusInForm = document.activeElement === pw || pw.form.contains(document.activeElement);
    if (!inForm && !focusInForm) return;
  }
  ipcRenderer.send('credential-captured', {
    url: location.href,
    username: user && user.value ? user.value : '',
    password: pw.value,
  });
}

window.addEventListener('submit', capture, true);
// many dashboards submit via JS, so also capture on Enter and on clicking a submit-ish control
window.addEventListener('keydown', e => { if (e.key === 'Enter') setTimeout(() => capture(e), 0); }, true);
window.addEventListener('click', e => {
  const el = e.target && e.target.closest && e.target.closest('button,[type=submit],[role=button]');
  if (el) setTimeout(() => capture(e), 0);
}, true);

// ---- fill: main asks us to put a stored credential into the form ----
ipcRenderer.on('fill-credential', (_e, { username, password, submit }) => {
  const { user, pw } = findFields();
  const okU = username ? setValue(user, username) : false;
  const okP = setValue(pw, password);
  if (okP) pw.focus(); else if (okU) user.focus();
  if (submit && okP && pw.form) { try { pw.form.requestSubmit ? pw.form.requestSubmit() : pw.form.submit(); } catch {} }
  ipcRenderer.send('fill-result', { user: okU, password: okP });
});

// tell main whether this page even has a login form (drives the "fill" affordance)
function reportForm() {
  const { pw } = findFields();
  ipcRenderer.send('login-form-present', { present: !!pw, url: location.href });
}
window.addEventListener('DOMContentLoaded', () => setTimeout(reportForm, 300));
window.addEventListener('load', () => setTimeout(reportForm, 600));

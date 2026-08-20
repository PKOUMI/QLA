/**
 * ui.js — small DOM helpers used by every view.
 * Keeping these in one place stops the view files filling up with boilerplate.
 */

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

/** Create an element with attributes and children in one call. */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;      // only ever called with escaped strings
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }

/* --- Toasts -------------------------------------------------------------- */

export function toast(message, kind = 'info', ms = 4500) {
  const container = $('#toasts');
  const node = el('div', { class: `toast ${kind}`, role: 'status' },
    el('div', { style: 'flex:1', text: message }),
    el('button', { class: 'x', type: 'button', 'aria-label': 'Dismiss', onclick: () => node.remove() }, '×'),
  );
  container.append(node);
  if (ms) setTimeout(() => node.remove(), ms);
  return node;
}

/* --- Modal --------------------------------------------------------------- */

let modalCleanup = null;

/**
 * Open the shared modal.
 * @param {{title, body: Node|string, buttons: Array, wide?: boolean, onClose?: Function}} options
 */
export function openModal({ title, body, buttons = [], wide = false, onClose }) {
  const backdrop = $('#modal-backdrop');
  const modal = $('#modal');
  modal.classList.toggle('modal-wide', !!wide);
  $('#modal-title').textContent = title;

  const bodyNode = clear($('#modal-body'));
  bodyNode.classList.toggle('flush', body instanceof HTMLIFrameElement);
  bodyNode.append(typeof body === 'string' ? el('div', { html: body }) : body);

  const foot = clear($('#modal-foot'));
  for (const button of buttons) {
    foot.append(el('button', {
      class: `btn ${button.class || ''} ${button.align === 'left' ? 'left' : ''}`.trim(),
      type: 'button',
      id: button.id || null,
      onclick: () => { if (button.onClick) button.onClick(); if (button.close !== false) closeModal(); },
    }, button.label));
  }

  backdrop.classList.add('is-open');
  const onKey = (event) => { if (event.key === 'Escape') closeModal(); };
  const onBackdrop = (event) => { if (event.target === backdrop) closeModal(); };
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('mousedown', onBackdrop);

  modalCleanup = () => {
    document.removeEventListener('keydown', onKey);
    backdrop.removeEventListener('mousedown', onBackdrop);
    if (onClose) onClose();
  };

  const focusTarget = modal.querySelector('input,select,textarea,button');
  if (focusTarget) focusTarget.focus();
}

export function closeModal() {
  $('#modal-backdrop').classList.remove('is-open');
  if (modalCleanup) { modalCleanup(); modalCleanup = null; }
}

/** Promise-based confirmation dialog. Resolves true/false. */
export function confirmDialog({ title, message, confirmLabel = 'Continue', danger = false }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    openModal({
      title,
      body: typeof message === 'string' ? el('p', { text: message, style: 'margin:0' }) : message,
      buttons: [
        { label: 'Cancel', onClick: () => finish(false) },
        { label: confirmLabel, class: danger ? 'btn-danger' : 'btn-primary', onClick: () => finish(true) },
      ],
      onClose: () => finish(false),
    });
  });
}

/* --- Message blocks ------------------------------------------------------ */

const ICONS = { info: 'ℹ️', warn: '⚠️', bad: '⛔', ok: '✅' };

export function callout(kind, title, items = []) {
  const list = Array.isArray(items) ? items : [items];
  return el('div', { class: `callout callout-${kind}` },
    el('span', { class: 'ico', 'aria-hidden': 'true', text: ICONS[kind] || ICONS.info }),
    el('div', {},
      title ? el('strong', { text: title }) : null,
      list.length === 1
        ? el('span', { text: list[0] })
        : el('ul', {}, list.map((item) => el('li', { text: item }))),
    ),
  );
}

/** Replace a container's contents with error/warning callouts. */
export function renderMessages(container, { errors = [], warnings = [], okMessage = '' } = {}) {
  clear(container);
  if (errors.length) {
    container.append(callout('bad', errors.length === 1 ? 'There is a problem' : `${errors.length} problems to fix`, errors));
  }
  if (warnings.length) {
    container.append(callout('warn', warnings.length === 1 ? 'Worth checking' : `${warnings.length} things worth checking`, warnings));
  }
  if (!errors.length && !warnings.length && okMessage) {
    container.append(callout('ok', '', okMessage));
  }
}

/* --- Files --------------------------------------------------------------- */

export function downloadFile(filename, content, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = el('a', { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.readAsText(file);
  });
}

/** Debounce, used so we don't write to storage on every keystroke. */
export function debounce(fn, ms = 400) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function plural(count, singular, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

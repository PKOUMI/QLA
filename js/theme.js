/**
 * theme.js — day, night, or whatever the computer is set to.
 *
 * Three states rather than two. "Follow my computer" is the one most people
 * actually want, because their machine already switches at dusk, and an app
 * that ignores that is an app they have to remember to switch by hand.
 *
 * The choice is per browser, not per account. It is a comfort setting about
 * the room somebody is sitting in — a teacher on a bright projector-lit
 * classroom machine and the same teacher at home at 9pm want different
 * answers, and syncing it would force one on both.
 */

const KEY = 'qla.theme.v1';
export const ORDER = ['system', 'light', 'dark'];

const LABELS = {
  system: { name: 'Match my computer', icon: '◐' },
  light: { name: 'Day', icon: '☀' },
  dark: { name: 'Night', icon: '☾' },
};

export function stored() {
  try {
    const value = localStorage.getItem(KEY);
    return ORDER.includes(value) ? value : 'system';
  } catch { return 'system'; }
}

/** What is actually on screen, once "system" has been resolved. */
export function resolved(choice = stored()) {
  if (choice !== 'system') return choice;
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch { return 'light'; }
}

export function apply(choice = stored()) {
  const active = resolved(choice);
  document.documentElement.setAttribute('data-theme', active);
  document.documentElement.style.colorScheme = active;
  return active;
}

export function setTheme(choice) {
  try { localStorage.setItem(KEY, choice); } catch { /* private browsing */ }
  return apply(choice);
}

export function describe(choice = stored()) {
  return LABELS[choice] || LABELS.system;
}

/** Follow the computer as it changes, but only while set to follow it. */
export function watchSystem() {
  try {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    query.addEventListener('change', () => { if (stored() === 'system') apply('system'); });
  } catch { /* an older browser; the setting still works, it just will not follow */ }
}

/**
 * The header control. One button that cycles, because a three-way menu for a
 * three-way choice is more machinery than the decision deserves.
 */
export function initThemeButton(button) {
  if (!button) return;

  const paint = () => {
    const choice = stored();
    const { name, icon } = describe(choice);
    button.textContent = icon;
    const active = resolved(choice);
    button.title = `${name}${choice === 'system' ? ` — currently ${active}` : ''}. Click to change.`;
    button.setAttribute('aria-label', button.title);
  };

  button.addEventListener('click', () => {
    const next = ORDER[(ORDER.indexOf(stored()) + 1) % ORDER.length];
    setTheme(next);
    paint();
  });

  paint();
  watchSystem();
}

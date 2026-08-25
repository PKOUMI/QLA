/**
 * markers.js — who is marking this paper.
 *
 * A teacher can only enter marks on an assessment they have been put on. This
 * is where an admin does the putting; before it existed the answer was an
 * INSERT statement, which is not an answer.
 *
 * Assignment is stored the moment a box is ticked, not on a Save button.
 * Everything else in this app saves as you go, and one screen that does not
 * would be the one that loses somebody's work.
 */

import { el, clear, toast, $ } from './ui.js';
import { listStaff, listMarkers, setMarkers } from './people.js';
import { canManage } from './roles.js';

let cache = null;          // the staff list, which does not change per keystroke

async function staffList() {
  if (!cache) cache = await listStaff();
  return cache;
}

export function forget() { cache = null; }

/**
 * @param {object} assessment
 * @param {{user: {id: string}}|null} session
 */
export async function render(assessment, session) {
  const host = $('#markers-card');
  if (!host) return;

  // Browser-only mode has no staff and no assignments to make.
  if (!session) { host.hidden = true; return; }
  host.hidden = false;

  const [staff, assigned] = await Promise.all([staffList(), listMarkers(assessment.id)]);
  const chosen = new Set(assigned);
  const editable = canManage();

  const rows = staff.map((person) => {
    if (!person.userId) {
      // Invited but never signed in: there is no account to attach yet.
      return el('label', { class: 'marker-row is-waiting' },
        el('input', { type: 'checkbox', disabled: true }),
        el('span', {}, el('strong', { text: person.email }),
          el('small', { text: 'Has not signed in yet, so cannot be put on a paper' })));
    }

    const box = el('input', {
      type: 'checkbox',
      checked: chosen.has(person.userId) || null,
      onchange: async (event) => {
        const wanted = new Set(chosen);
        if (event.target.checked) wanted.add(person.userId); else wanted.delete(person.userId);
        try {
          await setMarkers(assessment.id, [...wanted], session.user.id);
          if (event.target.checked) chosen.add(person.userId); else chosen.delete(person.userId);
          toast(event.target.checked
            ? `${person.email} can now enter marks for this paper.`
            : `${person.email} can no longer enter marks for this paper.`, 'ok', 3000);
        } catch (error) {
          event.target.checked = chosen.has(person.userId);   // put the tick back
          toast(error.message || 'Could not change who is marking this paper.', 'bad', 9000);
        }
      },
    });

    return el('label', { class: 'marker-row' }, box,
      el('span', {}, el('strong', { text: person.email }),
        el('small', { text: person.role === 'teacher' ? 'Teacher' : 'Admin — can mark any paper anyway' })));
  });

  clear(host).append(
    el('div', { class: 'card' },
      el('div', { class: 'card-head' },
        el('h2', { text: 'Who is marking this paper' }),
        el('span', { class: 'badge badge-brand', text: `${chosen.size} assigned` }),
        el('div', { class: 'spacer' }),
        el('p', { class: 'note-inline', text: editable
          ? 'Tick the staff who will enter marks. They can open this assessment and fill in the marksheet, and nothing else. Admins can always mark, whether ticked or not.'
          : 'These are the staff who can enter marks for this paper. Only an admin can change the list.' }),
      ),
      el('div', { class: 'card-body' },
        staff.length ? el('div', { class: 'marker-list' }, rows)
          : el('p', { class: 'hint', text: 'Nobody else has been added to your school yet. Use Staff in the header to add colleagues.' })),
    ),
  );
}

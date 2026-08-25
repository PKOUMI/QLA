/**
 * staff.js — the Staff screen.
 *
 * Everyone at the school, what they may do, and whether they have ever
 * actually signed in. That last column is the one that answers the question an
 * admin really has, which is "did Rachel get the email or not?".
 */

import { el, clear, openModal, toast, confirmDialog, $ } from './ui.js';
import { listStaff, inviteStaff, setStaffRole, removeStaff, ROLES, roleLabel } from './people.js';
import { canManage } from './roles.js';

function pill(person) {
  return person.signedIn
    ? el('span', { class: 'badge badge-ok', text: 'Signed in' })
    : el('span', { class: 'badge badge-neutral', title: 'They have been added, but have not signed in yet.', text: 'Not yet' });
}

async function refresh(body, me) {
  const container = clear(body);
  let staff;
  try {
    staff = await listStaff();
  } catch (error) {
    container.append(el('div', { class: 'callout callout-bad' },
      el('span', { class: 'ico', text: '⛔' }),
      el('div', {}, el('strong', { text: 'Could not load the staff list' }), el('span', { text: error.message }))));
    return;
  }

  const editable = canManage();

  if (editable) {
    const address = el('input', { type: 'email', id: 'staff-email', placeholder: 'colleague@yourschool.sch.uk', autocomplete: 'off' });
    const role = el('select', { id: 'staff-role' },
      ...ROLES.map((item) => el('option', { value: item.value, text: item.label })));

    const form = el('form', {
      class: 'staff-add',
      onsubmit: async (event) => {
        event.preventDefault();
        const email = address.value.trim();
        if (!email) return;
        try {
          await inviteStaff(email, role.value);
          toast(`${email} can now sign in.`, 'ok');
          address.value = '';
          await refresh(body, me);
        } catch (error) {
          toast(error.message, 'bad', 9000);
        }
      },
    },
      el('div', { class: 'field' }, el('label', { for: 'staff-email', text: 'Add a colleague' }), address),
      el('div', { class: 'field' }, el('label', { for: 'staff-role', text: 'They can' }), role),
      el('button', { class: 'btn btn-primary', type: 'submit' }, 'Add'),
    );
    container.append(form);
    container.append(el('p', { class: 'hint', style: 'margin:-4px 0 16px' },
      'They sign in at this address with their own email. No account or password is created for them, and nobody who is not on this list can get in.'));
  }

  const rows = staff.map((person) => {
    const isMe = person.email.toLowerCase() === String(me || '').toLowerCase();

    const roleCell = editable && !isMe
      ? el('select', {
        'aria-label': `What ${person.email} can do`,
        onchange: async (event) => {
          const wanted = event.target.value;
          try {
            await setStaffRole(person.email, wanted);
            toast(`${person.email} is now ${roleLabel(wanted).toLowerCase()}.`, 'ok');
            await refresh(body, me);
          } catch (error) {
            toast(error.message, 'bad', 9000);
            event.target.value = person.role;    // put the menu back
          }
        },
      }, ...ROLES.map((item) => el('option', {
        value: item.value, selected: item.value === person.role || null, text: item.label,
      })))
      : el('span', { text: roleLabel(person.role) });

    return el('tr', {},
      el('td', {}, el('strong', { text: person.email }), isMe ? el('span', { class: 'hint', text: ' (you)' }) : null),
      el('td', {}, roleCell),
      el('td', {}, pill(person)),
      el('td', { style: 'text-align:right' },
        editable && !isMe
          ? el('button', {
            class: 'btn btn-sm btn-danger', type: 'button',
            onclick: async () => {
              const ok = await confirmDialog({
                title: 'Remove from this school?',
                message: `${person.email} will no longer be able to sign in to EveryPupil for your school. `
                  + 'Any marks they entered stay where they are — the work belongs to the school.',
                confirmLabel: 'Remove', danger: true,
              });
              if (!ok) return;
              try {
                await removeStaff(person.email);
                toast(`${person.email} was removed.`, 'ok');
                await refresh(body, me);
              } catch (error) {
                toast(error.message, 'bad', 9000);
              }
            },
          }, 'Remove')
          : null),
    );
  });

  container.append(el('div', { class: 'table-wrap' },
    el('table', { class: 'data' },
      el('thead', {}, el('tr', {},
        el('th', { text: 'Email' }),
        el('th', { text: 'Can' }),
        el('th', { text: 'Signed in' }),
        el('th', {}))),
      el('tbody', {}, rows))));

  const waiting = staff.filter((person) => !person.signedIn).length;
  container.append(el('p', { class: 'hint', style: 'margin-top:12px' },
    `${staff.length} ${staff.length === 1 ? 'person' : 'people'}`
    + (waiting ? `, ${waiting} not signed in yet.` : '. Everybody has signed in at least once.')));
}

export function openStaff(me) {
  const body = el('div', {});
  openModal({
    title: 'Staff',
    body,
    wide: true,
    buttons: [{ label: 'Close' }],
  });
  refresh(body, me);
}

/** Show the Staff button only once there is a school to have staff. */
export function initStaffButton(session) {
  const button = $('#btn-staff');
  if (!button) return;
  button.hidden = !session;
  if (session) button.addEventListener('click', () => openStaff(session.user.email));
}

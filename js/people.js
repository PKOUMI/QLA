/**
 * people.js — staff, and who is marking what.
 *
 * Every change goes through a database function rather than a table write.
 * The rules that matter here are not per-row rules — "a school must never be
 * left without an owner" cannot be expressed as a policy on a single row — so
 * they live in one place in SQL, and this file just calls them and shows
 * whatever they say. See supabase/migrations/0004_staff.sql.
 */

import { rpc, selectRows, insertRows, deleteRows } from './supabase.js';

export const ROLES = [
  { value: 'teacher', label: 'Teacher', can: 'Enters marks on the papers they are given' },
  { value: 'admin', label: 'Admin', can: 'Sets up assessments, sends feedback, manages staff' },
  { value: 'owner', label: 'Owner', can: 'The same as admin. A school always has at least one' },
];

export function roleLabel(value) {
  return ROLES.find((role) => role.value === value)?.label || value;
}

/**
 * Everybody at the school: those who have signed in, and those who have been
 * added but have not been in yet. The second group is the one an admin most
 * needs to see, because they are about to ask whether the email arrived.
 */
export async function listStaff() {
  const rows = await rpc('school_staff');
  return (rows || []).map((row) => ({
    userId: row.user_id,
    email: row.email,
    role: row.member_role,
    signedIn: !!row.signed_in,
    invitedAt: row.invited_at,
  }));
}

/**
 * The database raises its refusals as ordinary Postgres errors, which arrive
 * with a lot of machinery around them. The message inside was written to be
 * read by the person who tried, so dig it out and let it through.
 */
function readable(error) {
  const message = String(error?.message || '');
  const cleaned = message
    .replace(/^ERROR:\s*/i, '')
    .replace(/\s*CONTEXT:.*$/is, '')
    .replace(/\s*(SQL statement|PL\/pgSQL function).*$/is, '')
    .trim();
  return cleaned || 'That did not work. Please try again.';
}

async function callGuarded(name, args) {
  try {
    return await rpc(name, args);
  } catch (error) {
    throw new Error(readable(error));
  }
}

export const inviteStaff = (email, role) => callGuarded('invite_staff', { addr: email, new_role: role });
export const setStaffRole = (email, role) => callGuarded('set_staff_role', { addr: email, new_role: role });
export const removeStaff = (email) => callGuarded('remove_staff', { addr: email });

/* --- Who is marking this paper ------------------------------------------- */

export async function listMarkers(assessmentId) {
  const rows = await selectRows('assessment_teachers', {
    select: 'user_id', eq: { assessment_id: assessmentId },
  });
  return rows.map((row) => row.user_id);
}

/**
 * Save the marker list, sending only the difference.
 *
 * Clearing the list and re-adding it would work, and would also mean that a
 * momentary gap could refuse a colleague's save mid-marking. Add and remove
 * only what actually changed.
 */
export async function setMarkers(assessmentId, userIds, addedBy) {
  const before = new Set(await listMarkers(assessmentId));
  const after = new Set(userIds);

  const added = [...after].filter((id) => !before.has(id));
  const removed = [...before].filter((id) => !after.has(id));

  if (added.length) {
    await insertRows('assessment_teachers',
      added.map((id) => ({ assessment_id: assessmentId, user_id: id, added_by: addedBy })),
      { upsert: true, onConflict: 'assessment_id,user_id' });
  }
  if (removed.length) {
    await deleteRows('assessment_teachers', { assessment_id: assessmentId }, { user_id: removed });
  }
  return { added: added.length, removed: removed.length };
}

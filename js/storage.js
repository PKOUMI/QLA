/**
 * storage.js — persistence.
 *
 * The rest of the app only ever talks to `repo`. Today `repo` is backed by
 * localStorage; swapping in a database later means writing a new adapter with
 * the same four methods and changing one line at the bottom of this file.
 *
 * Every method is async even though localStorage is synchronous — that is
 * deliberate, so that no calling code has to change when it becomes a network
 * call.
 */

import { migrate, newAssessment } from './model.js';

const KEY_DOCS = 'qla.assessments.v1';
const KEY_CURRENT = 'qla.currentAssessmentId.v1';
const KEY_SETTINGS = 'qla.settings.v1';

function readAll() {
  try {
    const raw = localStorage.getItem(KEY_DOCS);
    return raw ? JSON.parse(raw) : {};
  } catch (error) {
    console.error('Could not read saved assessments', error);
    return {};
  }
}

function writeAll(docs) {
  try {
    localStorage.setItem(KEY_DOCS, JSON.stringify(docs));
    return true;
  } catch (error) {
    // Most likely QuotaExceededError. The caller must be told — silently
    // failing to save a teacher's marks would be the worst possible bug.
    console.error('Could not save', error);
    throw new Error('Could not save your work. Your browser storage may be full or blocked (check private browsing mode).');
  }
}

/** localStorage-backed implementation of the repository interface. */
export const localRepo = {
  async list() {
    const docs = readAll();
    return Object.values(docs)
      .map((d) => ({
        id: d.id,
        name: d.exam?.name || 'Untitled assessment',
        className: d.exam?.className || '',
        updatedAt: d.updatedAt,
        pupilCount: (d.pupils || []).length,
      }))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  },

  async get(id) {
    const docs = readAll();
    return docs[id] ? migrate(docs[id]) : null;
  },

  async save(assessment) {
    const docs = readAll();
    assessment.updatedAt = new Date().toISOString();
    docs[assessment.id] = assessment;
    writeAll(docs);
    return assessment;
  },

  async remove(id) {
    const docs = readAll();
    delete docs[id];
    writeAll(docs);
    if (localStorage.getItem(KEY_CURRENT) === id) localStorage.removeItem(KEY_CURRENT);
  },
};

/*
 * Later, this becomes:
 *
 * export const apiRepo = {
 *   async list()            { return http('GET',    '/v1/assessments'); },
 *   async get(id)           { return http('GET',   `/v1/assessments/${id}`); },
 *   async save(assessment)  { return http('PUT',   `/v1/assessments/${assessment.id}`, assessment); },
 *   async remove(id)        { return http('DELETE',`/v1/assessments/${id}`); },
 * };
 *
 * ...and the export below switches. No other file changes.
 */
export const repo = localRepo;

/* --- Which assessment is open ------------------------------------------- */

export function getCurrentId() {
  try { return localStorage.getItem(KEY_CURRENT); } catch { return null; }
}

export function setCurrentId(id) {
  try {
    if (id) localStorage.setItem(KEY_CURRENT, id);
    else localStorage.removeItem(KEY_CURRENT);
  } catch { /* storage blocked; the app still works for this session */ }
}

/** Load the open assessment, creating a blank one on first run. */
export async function loadCurrentAssessment() {
  const id = getCurrentId();
  if (id) {
    const found = await repo.get(id);
    if (found) return found;
  }
  const created = newAssessment();
  await repo.save(created);
  setCurrentId(created.id);
  return created;
}

/* --- App settings (API URL and key) -------------------------------------
 * These are per-teacher, per-browser, and are NOT secrets in the cryptographic
 * sense — see ARCHITECTURE.md §6. The shared key is a speed bump against a
 * stranger finding the endpoint, not authentication.
 * ---------------------------------------------------------------------- */

export function getSettings() {
  const defaults = {
    apiBaseUrl: (window.QLA_CONFIG && window.QLA_CONFIG.apiBaseUrl) || '',
    apiKey: '',
    fromName: '',
  };
  try {
    const raw = localStorage.getItem(KEY_SETTINGS);
    return raw ? { ...defaults, ...JSON.parse(raw) } : defaults;
  } catch {
    return defaults;
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(KEY_SETTINGS, JSON.stringify(settings));
  } catch (error) {
    console.error('Could not save settings', error);
  }
}

/* --- Backup / restore ---------------------------------------------------
 * localStorage is not a backup. This gives the teacher a real file.
 * ---------------------------------------------------------------------- */

export function exportAssessmentJson(assessment) {
  return JSON.stringify(assessment, null, 2);
}

export function importAssessmentJson(text) {
  const parsed = JSON.parse(text);
  const doc = migrate(parsed);
  if (!doc) throw new Error('That file is not a valid QLA assessment.');
  return doc;
}

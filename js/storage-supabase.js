/**
 * storage-supabase.js — the database behind the same four methods
 * (`list`, `get`, `save`, `remove`) that localStorage provided.
 *
 * WHY THIS SAVES A DIFFERENCE AND NOT A DOCUMENT
 *
 * The browser version wrote the whole assessment on every keystroke, because
 * writing 4KB to localStorage costs nothing. Against a database that would be
 * wrong three times over:
 *
 *   1. A class of 90 with a 40-question paper is 3,600 marks. Rewriting all of
 *      them because somebody typed one number is absurd.
 *   2. Two teachers marking the same paper would overwrite each other. Sending
 *      only the cells that changed means their edits merge instead.
 *   3. A teacher may write marks but not the paper. A whole-document save
 *      includes the paper, so the database would refuse the write — and the
 *      teacher would lose marks they had every right to enter.
 *
 * So each save works out what actually changed since the last one and sends
 * only that. Marks go first, so that if anything else is refused, the marks
 * are already safe.
 */

import { selectRows, insertRows, updateRows, deleteRows, SupabaseError } from './supabase.js';
import { migrate, newId, isUuid } from './model.js';

/* --- Documents saved before there was a database ------------------------- */

/**
 * Give every part of an old document a UUID, keeping the marks pointing at the
 * right pupils and questions. Mutates in place and returns the document.
 *
 * Assessments created in the browser before this release used ids like
 * `q_lz3k1abc`, which are not UUIDs and cannot be stored. Rather than strand
 * that work, remap it once on the way in.
 */
export function reidentify(doc) {
  const remap = new Map();
  const fresh = (old) => {
    if (isUuid(old)) return old;
    if (!remap.has(old)) remap.set(old, newId('id'));
    return remap.get(old);
  };

  doc.id = fresh(doc.id);
  for (const question of doc.questions) question.id = fresh(question.id);
  for (const pupil of doc.pupils) pupil.id = fresh(pupil.id);

  const marks = {};
  for (const [pupilId, row] of Object.entries(doc.marks || {})) {
    const movedRow = {};
    for (const [questionId, value] of Object.entries(row || {})) {
      movedRow[fresh(questionId)] = value;
    }
    marks[fresh(pupilId)] = movedRow;
  }
  doc.marks = marks;

  doc.feedback.selectedPupilIds = (doc.feedback.selectedPupilIds || []).map(fresh);
  doc.feedback.parentSelectedPupilIds = (doc.feedback.parentSelectedPupilIds || []).map(fresh);

  const pupilText = {};
  for (const [pupilId, value] of Object.entries(doc.pupilEmailText || {})) {
    pupilText[fresh(pupilId)] = value;
  }
  doc.pupilEmailText = pupilText;

  for (const entry of doc.sendLog || []) entry.batchId = fresh(entry.batchId);

  return doc;
}

/* --- Document <-> rows --------------------------------------------------- */

const emptyToNull = (value) => (value === '' || value === undefined ? null : value);

export function toAssessmentRow(doc, orgId, ownerId) {
  return {
    id: doc.id,
    org_id: orgId,
    owner_id: ownerId,
    name: doc.exam.name || 'Untitled assessment',
    subject: emptyToNull(doc.exam.subject),
    exam_date: emptyToNull(doc.exam.date),
    paper_type: doc.exam.paperType,
    blank_policy: doc.exam.blankPolicy,
    grade_boundaries: doc.gradeBoundaries,
    email_text: doc.emailText,
    lock_pin_hash: doc.settings.lock.pinHash,
    lock_salt: doc.settings.lock.salt,
    // Everything with no column of its own. These are the app's own working
    // state — which charts are showing, who is ticked for feedback — not
    // things the database ever needs to query on.
    settings: {
      schemaVersion: doc.schemaVersion,
      teacherEmail: doc.exam.teacherEmail || '',
      lockEnabled: !!doc.settings.lock.enabled,
      analyse: doc.settings.analyse,
      feedback: doc.feedback,
      pupilEmailText: doc.pupilEmailText,
    },
  };
}

export function toQuestionRows(doc) {
  return doc.questions.map((question, index) => ({
    id: question.id,
    assessment_id: doc.id,
    position: index,
    number: String(question.number ?? ''),
    max_marks: question.maxMarks,
    topic: emptyToNull(question.topic),
    reteach_url: emptyToNull(question.reteachUrl),
  }));
}

export function toPupilRows(doc, orgId) {
  return doc.pupils.map((pupil) => ({
    id: pupil.id,
    org_id: orgId,
    name: pupil.name || '',
    email: emptyToNull(pupil.email),
    parent_email: emptyToNull(pupil.parentEmail),
  }));
}

export function toEntryRows(doc) {
  return doc.pupils.map((pupil, index) => ({
    assessment_id: doc.id,
    pupil_id: pupil.id,
    position: index,
  }));
}

/**
 * Every mark that has a value, flattened. `null` is kept: it means the cell
 * was cleared, which is different from never having been marked.
 *
 * Marks belonging to a pupil or a question that is no longer on the paper are
 * dropped. They can linger in a document after a row is deleted, and the
 * database would refuse the whole save because of them — losing good marks
 * over stale ones.
 */
export function toMarkRows(doc) {
  const pupilIds = new Set(doc.pupils.map((pupil) => pupil.id));
  const questionIds = new Set(doc.questions.map((question) => question.id));
  const rows = [];

  for (const [pupilId, row] of Object.entries(doc.marks || {})) {
    if (!pupilIds.has(pupilId)) continue;
    for (const [questionId, value] of Object.entries(row || {})) {
      if (!questionIds.has(questionId)) continue;
      rows.push({
        assessment_id: doc.id,
        pupil_id: pupilId,
        question_id: questionId,
        mark: value === undefined ? null : value,
      });
    }
  }
  return rows;
}

export function toSendLogRows(doc, userId) {
  return (doc.sendLog || []).map((entry) => ({
    id: entry.batchId,
    assessment_id: doc.id,
    sent_by: userId,
    sent_at: entry.at,
    recipients: entry.total ?? 0,
    succeeded: entry.sent ?? 0,
    failed: entry.failed ?? 0,
  }));
}

/** Rebuild the document the rest of the app expects. */
export function fromRows({ assessment, questions, pupils, entries, marks, sendLog }) {
  const settings = assessment.settings || {};
  const byId = new Map(pupils.map((p) => [p.id, p]));

  const orderedPupils = [...entries]
    .sort((a, b) => a.position - b.position)
    .map((entry) => byId.get(entry.pupil_id))
    .filter(Boolean)
    .map((row) => ({
      id: row.id,
      name: row.name || '',
      email: row.email || '',
      parentEmail: row.parent_email || '',
    }));

  const markMap = {};
  for (const row of marks) {
    if (!markMap[row.pupil_id]) markMap[row.pupil_id] = {};
    markMap[row.pupil_id][row.question_id] = row.mark === null ? null : Number(row.mark);
  }

  return migrate({
    schemaVersion: settings.schemaVersion,
    id: assessment.id,
    createdAt: assessment.created_at,
    updatedAt: assessment.updated_at,
    exam: {
      name: assessment.name === 'Untitled assessment' ? '' : (assessment.name || ''),
      subject: assessment.subject || '',
      teacherEmail: settings.teacherEmail || '',
      date: assessment.exam_date || '',
      paperType: assessment.paper_type,
      blankPolicy: assessment.blank_policy,
    },
    questions: [...questions]
      .sort((a, b) => a.position - b.position)
      .map((row) => ({
        id: row.id,
        number: row.number,
        maxMarks: Number(row.max_marks),
        topic: row.topic || '',
        reteachUrl: row.reteach_url || '',
      })),
    gradeBoundaries: assessment.grade_boundaries,
    pupils: orderedPupils,
    marks: markMap,
    feedback: settings.feedback,
    settings: {
      lock: {
        enabled: !!settings.lockEnabled,
        pinHash: assessment.lock_pin_hash,
        salt: assessment.lock_salt,
      },
      analyse: settings.analyse,
    },
    emailText: assessment.email_text || {},
    pupilEmailText: settings.pupilEmailText || {},
    sendLog: [...sendLog]
      .sort((a, b) => String(a.sent_at).localeCompare(String(b.sent_at)))
      .map((row) => ({
        at: row.sent_at,
        batchId: row.id,
        sent: row.succeeded,
        failed: row.failed,
        total: row.recipients,
      })),
  });
}

/* --- Working out what changed -------------------------------------------- */

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Compare two lists of rows that both carry an `id`. */
export function diffRows(before, after, key = 'id') {
  const previous = new Map(before.map((row) => [row[key], row]));
  const insert = [];
  const update = [];

  for (const row of after) {
    const was = previous.get(row[key]);
    if (!was) insert.push(row);
    else if (!same(was, row)) update.push(row);
    previous.delete(row[key]);
  }

  return { insert, update, remove: [...previous.values()] };
}

/** Marks are compared cell by cell, because that is how they are edited. */
export function diffMarks(before, after) {
  const keyOf = (row) => `${row.pupil_id} ${row.question_id}`;
  const previous = new Map(before.map((row) => [keyOf(row), row]));
  const changed = [];

  for (const row of after) {
    const was = previous.get(keyOf(row));
    // Written out rather than compared with !== so that a cleared cell (null)
    // and a zero are never mistaken for one another.
    const differs = !was
      || (was.mark === null) !== (row.mark === null)
      || (row.mark !== null && Number(was.mark) !== Number(row.mark));
    if (differs) changed.push(row);
    previous.delete(keyOf(row));
  }

  return { changed, remove: [...previous.values()] };
}

/**
 * The complete set of writes needed to turn `before` into `after`.
 * Pure, and exported so it can be tested without a database.
 */
export function planWrites(before, after, { orgId, userId }) {
  const afterMarks = toMarkRows(after);
  const afterAssessment = toAssessmentRow(after, orgId, userId);

  return {
    marks: before ? diffMarks(toMarkRows(before), afterMarks) : { changed: afterMarks, remove: [] },
    assessment: (!before || !same(toAssessmentRow(before, orgId, userId), afterAssessment))
      ? afterAssessment : null,
    questions: diffRows(before ? toQuestionRows(before) : [], toQuestionRows(after)),
    pupils: diffRows(before ? toPupilRows(before, orgId) : [], toPupilRows(after, orgId)),
    entries: diffRows(before ? toEntryRows(before) : [], toEntryRows(after), 'pupil_id'),
    sendLog: diffRows(before ? toSendLogRows(before, userId) : [], toSendLogRows(after, userId)),
  };
}

/** Nothing to send? Then send nothing. */
export function isEmptyPlan(plan) {
  const empty = (part) => (part.insert?.length || 0) + (part.update?.length || 0)
    + (part.remove?.length || 0) + (part.changed?.length || 0) === 0;
  return !plan.assessment && empty(plan.marks) && empty(plan.questions)
    && empty(plan.pupils) && empty(plan.entries) && empty(plan.sendLog);
}

/* --- Errors a teacher can act on ----------------------------------------- */

export function describeWriteError(error, what) {
  const text = String(error?.message || '').toLowerCase();
  if (error?.status === 403 || /row-level security|violates row-level/.test(text)) {
    return `Your marks were saved, but ${what} needs an admin. Ask whoever set up this assessment to make the change.`;
  }
  if (/foreign key/.test(text)) {
    return 'Some of this data refers to a pupil or question that is no longer on this paper. Reload the page to get the current version.';
  }
  if (/duplicate key|unique constraint/.test(text) || error?.status === 409) {
    return 'A pupil with that email address is already on your school list. Two records for one child would mean two feedback emails, so the database will not allow it.';
  }
  if (error?.status === 401) {
    return 'Your session has expired. Reload the page and sign in again — nothing has been lost.';
  }
  return error?.message || 'Could not save. Check your connection and try again.';
}

/* --- The repository ------------------------------------------------------ */

const CHUNK = 400;

async function inChunks(rows, run) {
  for (let start = 0; start < rows.length; start += CHUNK) {
    await run(rows.slice(start, start + CHUNK));
  }
}

/**
 * @param {{orgId: string, userId: string}} identity
 */
export function createSupabaseRepo({ orgId, userId }) {
  /** What we believe is in the database, per assessment. */
  const snapshots = new Map();
  const remember = (doc) => snapshots.set(doc.id, structuredClone(doc));

  return {
    async list() {
      const rows = await selectRows('assessments', {
        select: 'id,name,subject,updated_at',
        eq: { org_id: orgId },
        order: 'updated_at.desc',
      });
      if (!rows.length) return [];

      // Counting entries in one query and tallying here, rather than asking
      // the database once per assessment.
      const entries = await selectRows('assessment_pupils', {
        select: 'assessment_id',
        in: { assessment_id: rows.map((row) => row.id) },
      });
      const counts = new Map();
      for (const entry of entries) {
        counts.set(entry.assessment_id, (counts.get(entry.assessment_id) || 0) + 1);
      }

      return rows.map((row) => ({
        id: row.id,
        name: row.name || 'Untitled assessment',
        subject: row.subject || '',
        updatedAt: row.updated_at,
        pupilCount: counts.get(row.id) || 0,
      }));
    },

    async get(id) {
      const assessment = await selectRows('assessments', { eq: { id }, single: true });
      if (!assessment) return null;

      const [questions, entries, marks, sendLog] = await Promise.all([
        selectRows('questions', { eq: { assessment_id: id } }),
        selectRows('assessment_pupils', { eq: { assessment_id: id } }),
        selectRows('marks', { eq: { assessment_id: id } }),
        selectRows('send_log', { eq: { assessment_id: id } }),
      ]);

      const pupils = entries.length
        ? await selectRows('pupils', { in: { id: entries.map((entry) => entry.pupil_id) } })
        : [];

      const doc = fromRows({ assessment, questions, pupils, entries, marks, sendLog });
      remember(doc);
      return doc;
    },

    async save(doc) {
      reidentify(doc);
      const before = snapshots.get(doc.id) || null;
      const plan = planWrites(before, doc, { orgId, userId });
      if (isEmptyPlan(plan)) return doc;

      const writeMarks = async () => {
        if (!plan.marks.changed.length) return;
        await inChunks(plan.marks.changed, (rows) => insertRows('marks', rows, {
          upsert: true, onConflict: 'assessment_id,pupil_id,question_id',
        }));
      };

      const writeEverythingElse = async () => {
        // Pupils exist at school level, so they come before the entries that
        // put them in this paper, which come before anything referring to them.
        // Upsert, not insert. The same child sits several papers, and copying
        // a class from last term's assessment must reuse their record rather
        // than create a second one — a duplicated pupil is a duplicated email.
        if (plan.pupils.insert.length) {
          await insertRows('pupils', plan.pupils.insert, { upsert: true, onConflict: 'id' });
        }
        for (const row of plan.pupils.update) {
          await updateRows('pupils', { id: row.id }, row);
        }

        if (plan.assessment) {
          await insertRows('assessments', [plan.assessment], { upsert: true, onConflict: 'id' });
        }

        if (plan.questions.insert.length) await insertRows('questions', plan.questions.insert);
        for (const row of plan.questions.update) {
          await updateRows('questions', { id: row.id }, row);
        }
        if (plan.questions.remove.length) {
          await deleteRows('questions', {}, { id: plan.questions.remove.map((row) => row.id) });
        }

        if (plan.entries.insert.length) {
          await insertRows('assessment_pupils', plan.entries.insert,
            { upsert: true, onConflict: 'assessment_id,pupil_id' });
        }
        for (const row of plan.entries.update) {
          await updateRows('assessment_pupils',
            { assessment_id: row.assessment_id, pupil_id: row.pupil_id }, row);
        }
        if (plan.entries.remove.length) {
          // Removing the entry takes that paper's marks with it, by the
          // foreign key, and leaves the pupil and their other papers alone.
          await deleteRows('assessment_pupils', { assessment_id: doc.id },
            { pupil_id: plan.entries.remove.map((row) => row.pupil_id) });
        }

        if (plan.sendLog.insert.length) await insertRows('send_log', plan.sendLog.insert);
      };

      // ORDER MATTERS, AND IT IS NOT THE SAME BOTH TIMES.
      //
      // On an assessment that already exists, marks go first: if a later write
      // is refused because this teacher may not change the paper, the marks
      // they were entitled to enter are already safe.
      //
      // On the very first save there is nothing to be safe yet — a mark cannot
      // reference a pupil who is not on a paper that does not exist — so the
      // paper has to be built before the marks can land on it.
      const creating = before === null;

      if (creating) {
        try {
          await writeEverythingElse();
        } catch (error) {
          throw new Error(describeWriteError(error, 'creating this assessment'));
        }
        try {
          await writeMarks();
        } catch (error) {
          throw new Error(describeWriteError(error, 'saving these marks'));
        }
      } else {
        try {
          await writeMarks();
        } catch (error) {
          throw new Error(describeWriteError(error, 'saving these marks'));
        }
        try {
          await writeEverythingElse();
        } catch (error) {
          // The snapshot is deliberately NOT updated here. The next save will
          // work out the same outstanding changes and try them again.
          throw new Error(describeWriteError(error, 'changing this assessment'));
        }
      }

      remember(doc);
      return doc;
    },

    async remove(id) {
      await deleteRows('assessments', { id });
      snapshots.delete(id);
    },

    /** Only for tests and diagnostics. */
    _snapshot: (id) => snapshots.get(id),
  };
}

export { SupabaseError };

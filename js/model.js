/**
 * model.js — the shape of an assessment, and pure helpers for changing it.
 *
 * Nothing in this file touches the DOM or localStorage. That separation is what
 * lets the same logic run in a browser, in a Node test, and (later) on a server.
 */

export const SCHEMA_VERSION = 2;

/** Grades available for each paper tier, lowest first. */
export const GRADE_SETS = {
  foundation: ['U', '1', '2', '3', '4', '5'],
  higher: ['U', '3', '4', '5', '6', '7', '8', '9'],
};

/** Thresholds for the feedback rules. Defined once, used everywhere. */
export const WWW_THRESHOLD = 0.80; // strictly greater than this
export const EBI_THRESHOLD = 0.25; // strictly less than this

let idCounter = 0;
/** Short, collision-resistant-enough id. Replaced by a DB uuid later. */
export function newId(prefix) {
  idCounter += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}${rand}`;
}

export function newQuestion(number = '', maxMarks = 1) {
  return { id: newId('q'), number: String(number), maxMarks, topic: '', reteachUrl: '' };
}

export function newPupil(name = '', email = '', parentEmail = '') {
  return { id: newId('p'), name, email, parentEmail };
}

/** Default boundaries: U locked at 0, the rest left blank for the teacher. */
export function defaultBoundaries(paperType) {
  return GRADE_SETS[paperType].map((grade, i) => ({
    grade,
    minMark: i === 0 ? 0 : null,
  }));
}

export function newAssessment(overrides = {}) {
  const now = new Date().toISOString();
  const paperType = overrides.paperType || 'higher';
  return {
    schemaVersion: SCHEMA_VERSION,
    id: newId('asmt'),
    createdAt: now,
    updatedAt: now,
    exam: {
      name: '',
      subject: '',
      teacherEmail: '',
      date: '',
      paperType,
      blankPolicy: 'incomplete', // never silently treat blanks as zero
    },
    questions: [newQuestion('1', 1)],
    gradeBoundaries: defaultBoundaries(paperType),
    pupils: [],
    marks: {},
    feedback: {
      sendToParents: false,
      selectedPupilIds: [],
      // Kept separate from selectedPupilIds so a pupil can receive feedback
      // while their parents deliberately do not (e.g. safeguarding).
      parentSelectedPupilIds: [],
      teacherNote: '',
    },
    // Admin controls. `unlocked` is session state, not a saved secret.
    settings: {
      lock: { enabled: false, pinHash: null, salt: null },
      analyse: {
        charts: {
          gradeDistribution: true,
          topicPerformance: true,
          questionAverages: true,
          markDistribution: true,
        },
        gradeChartType: 'bar', // 'bar' | 'donut'
        topicSort: 'weakest',  // 'weakest' | 'strongest' | 'name'
      },
    },
    // Teacher/admin overrides for the wording of the feedback emails.
    emailText: {},
    sendLog: [],
    ...overrides,
  };
}

/* ---------------------------------------------------------------------------
 * Mark access. `null` means "not marked" and is deliberately different from 0.
 * ------------------------------------------------------------------------- */

export function getMark(assessment, pupilId, questionId) {
  const row = assessment.marks[pupilId];
  if (!row) return null;
  const value = row[questionId];
  return value === undefined ? null : value;
}

export function setMark(assessment, pupilId, questionId, value) {
  if (!assessment.marks[pupilId]) assessment.marks[pupilId] = {};
  if (value === null || value === '' || value === undefined) {
    assessment.marks[pupilId][questionId] = null;
  } else {
    assessment.marks[pupilId][questionId] = Number(value);
  }
}

/** Remove marks belonging to pupils/questions that no longer exist. */
export function pruneMarks(assessment) {
  const pupilIds = new Set(assessment.pupils.map((p) => p.id));
  const questionIds = new Set(assessment.questions.map((q) => q.id));
  for (const pupilId of Object.keys(assessment.marks)) {
    if (!pupilIds.has(pupilId)) {
      delete assessment.marks[pupilId];
      continue;
    }
    for (const questionId of Object.keys(assessment.marks[pupilId])) {
      if (!questionIds.has(questionId)) delete assessment.marks[pupilId][questionId];
    }
  }
  return assessment;
}

/**
 * Grow or shrink the question list to `count`, keeping existing questions and
 * their marks intact. Used by the "number of questions" field on Setup.
 */
export function resizeQuestions(assessment, count) {
  const target = Math.max(1, Math.min(200, Math.floor(count) || 1));
  while (assessment.questions.length < target) {
    assessment.questions.push(newQuestion(String(assessment.questions.length + 1), 1));
  }
  while (assessment.questions.length > target) {
    assessment.questions.pop();
  }
  pruneMarks(assessment);
  return assessment;
}

/** Switching tier keeps any boundary marks for grades that exist in both sets. */
export function applyPaperType(assessment, paperType) {
  const previous = new Map(assessment.gradeBoundaries.map((b) => [b.grade, b.minMark]));
  assessment.exam.paperType = paperType;
  assessment.gradeBoundaries = GRADE_SETS[paperType].map((grade, i) => ({
    grade,
    minMark: i === 0 ? 0 : (previous.has(grade) ? previous.get(grade) : null),
  }));
  return assessment;
}

/** Upgrade older saved documents. Keeps old saves loadable as the app evolves. */
export function migrate(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const doc = { ...newAssessment(), ...raw };
  doc.exam = { ...newAssessment().exam, ...(raw.exam || {}) };
  doc.feedback = { ...newAssessment().feedback, ...(raw.feedback || {}) };
  if (!Array.isArray(doc.feedback.parentSelectedPupilIds)) doc.feedback.parentSelectedPupilIds = [];

  // v1 -> v2: settings/emailText added, exam.className and exam.teacherName removed.
  const freshSettings = newAssessment().settings;
  doc.settings = {
    lock: { ...freshSettings.lock, ...(raw.settings?.lock || {}) },
    analyse: {
      ...freshSettings.analyse,
      ...(raw.settings?.analyse || {}),
      charts: { ...freshSettings.analyse.charts, ...(raw.settings?.analyse?.charts || {}) },
    },
  };
  doc.emailText = raw.emailText && typeof raw.emailText === 'object' ? raw.emailText : {};
  delete doc.exam.className;
  delete doc.exam.teacherName;
  doc.questions = Array.isArray(raw.questions) && raw.questions.length
    ? raw.questions
    : [newQuestion('1', 1)];
  doc.pupils = Array.isArray(raw.pupils) ? raw.pupils : [];
  doc.marks = raw.marks && typeof raw.marks === 'object' ? raw.marks : {};
  doc.sendLog = Array.isArray(raw.sendLog) ? raw.sendLog : [];
  if (!Array.isArray(raw.gradeBoundaries) || !raw.gradeBoundaries.length) {
    doc.gradeBoundaries = defaultBoundaries(doc.exam.paperType);
  }
  doc.schemaVersion = SCHEMA_VERSION;
  return doc;
}

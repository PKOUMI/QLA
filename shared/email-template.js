/**
 * shared/email-template.js
 *
 * Renders the feedback email. Imported by BOTH the browser (for the preview
 * screen) and the serverless function (for actual sending), so what a teacher
 * previews is byte-for-byte what the pupil receives.
 *
 * Deliberately self-contained: no imports, no DOM, no Node APIs. Plain ES module.
 *
 * Email HTML rules being followed here:
 *   - tables for layout (Outlook ignores flexbox and grid)
 *   - all styles inline (Gmail strips <style> in some clients)
 *   - max-width 600px with a fluid fallback for phones
 *   - a plain-text alternative, which improves deliverability and is what
 *     screen readers and locked-down school mail clients often show
 */

const COLOURS = {
  ink: '#0f172a',
  body: '#334155',
  muted: '#64748b',
  line: '#e2e8f0',
  panel: '#f8fafc',
  brand: '#4f46e5',
  brandDark: '#3730a3',
  strong: '#059669',
  strongBg: '#ecfdf5',
  weak: '#d97706',
  weakBg: '#fffbeb',
};

function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Only http(s) links are ever emitted. */
function safeHref(url) {
  try {
    const parsed = new URL(String(url));
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return parsed.href;
  } catch {
    return '';
  }
}

function formatDate(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

/* ------------------------------------------------------------------ blocks */

function bulletList(items, accent, background) {
  if (!items.length) return '';
  return items.map((item) => `
    <tr><td style="padding:0 0 6px 0;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        <td valign="top" style="width:22px;color:${accent};font-size:15px;line-height:22px;font-weight:700;">&bull;</td>
        <td style="color:${COLOURS.body};font-size:15px;line-height:22px;">${item}</td>
      </tr></table>
    </td></tr>`).join('');
}

/**
 * @param {string} titleHtml  already escaped, may contain placeholder markers
 * @param {string} editKey    when set, the heading becomes editable in the
 *                            preview (see the `editable` option)
 * @param {string} emptyNote  shown instead of the list when there is nothing
 *                            to say — only used in the editable preview, so
 *                            every heading can be reached and reworded
 */
function section(titleHtml, accent, background, innerRows, editKey = '', emptyNote = '') {
  if (!innerRows && !emptyNote) return '';
  const inner = innerRows || `
    <tr><td style="color:${COLOURS.muted};font-size:14px;line-height:22px;font-style:italic;">${esc(emptyNote)}</td></tr>`;
  const editAttr = editKey ? ` data-qla-edit="${editKey}"` : '';
  return `
  <tr><td style="padding:0 0 16px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
           style="background:${background};border:1px solid ${COLOURS.line};border-radius:10px;">
      <tr><td style="padding:16px 18px;">
        <p${editAttr} style="margin:0 0 10px 0;font-size:12px;letter-spacing:.08em;text-transform:uppercase;font-weight:700;color:${accent};">${titleHtml}</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${inner}</table>
      </td></tr>
    </table>
  </td></tr>`;
}

function questionTable(rows) {
  if (!rows.length) return '';
  const body = rows.map((row, index) => {
    const stripe = index % 2 === 1 ? COLOURS.panel : '#ffffff';
    const markCell = row.mark === null
      ? `<span style="color:${COLOURS.muted};font-style:italic;">not marked</span>`
      : `<strong style="color:${COLOURS.ink};">${esc(row.mark)}</strong>`;
    let dot = COLOURS.line;
    if (row.status === 'strong') dot = COLOURS.strong;
    else if (row.status === 'weak') dot = COLOURS.weak;
    else if (row.status === 'developing') dot = COLOURS.brand;
    return `
      <tr style="background:${stripe};">
        <td style="padding:9px 12px;border-bottom:1px solid ${COLOURS.line};font-size:14px;color:${COLOURS.ink};white-space:nowrap;">
          <span style="display:inline-block;width:8px;height:8px;border-radius:8px;background:${dot};margin-right:8px;"></span>Q${esc(row.number)}
        </td>
        <td style="padding:9px 12px;border-bottom:1px solid ${COLOURS.line};font-size:14px;color:${COLOURS.body};">${esc(row.topic) || '<span style="color:#94a3b8;">&mdash;</span>'}</td>
        <td align="right" style="padding:9px 12px;border-bottom:1px solid ${COLOURS.line};font-size:14px;">${markCell}</td>
        <td align="right" style="padding:9px 12px;border-bottom:1px solid ${COLOURS.line};font-size:14px;color:${COLOURS.muted};">${esc(row.outOf)}</td>
      </tr>`;
  }).join('');

  return `
  <tr><td style="padding:0 0 20px 0;">
    <p style="margin:0 0 10px 0;font-size:12px;letter-spacing:.08em;text-transform:uppercase;font-weight:700;color:${COLOURS.muted};">Question by question</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
           style="border:1px solid ${COLOURS.line};border-radius:10px;border-collapse:separate;overflow:hidden;">
      <tr style="background:${COLOURS.panel};">
        <th align="left"  style="padding:9px 12px;border-bottom:1px solid ${COLOURS.line};font-size:12px;color:${COLOURS.muted};text-transform:uppercase;letter-spacing:.05em;">Question</th>
        <th align="left"  style="padding:9px 12px;border-bottom:1px solid ${COLOURS.line};font-size:12px;color:${COLOURS.muted};text-transform:uppercase;letter-spacing:.05em;">Topic</th>
        <th align="right" style="padding:9px 12px;border-bottom:1px solid ${COLOURS.line};font-size:12px;color:${COLOURS.muted};text-transform:uppercase;letter-spacing:.05em;">Mark</th>
        <th align="right" style="padding:9px 12px;border-bottom:1px solid ${COLOURS.line};font-size:12px;color:${COLOURS.muted};text-transform:uppercase;letter-spacing:.05em;">Out of</th>
      </tr>
      ${body}
    </table>
  </td></tr>`;
}

function scorePanel(data) {
  const cell = (label, value, big) => `
    <td width="50%" align="center" style="padding:14px 8px;">
      <div style="font-size:${big ? '30px' : '26px'};line-height:1.1;font-weight:700;color:${COLOURS.ink};">${value}</div>
      <div style="font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:${COLOURS.muted};padding-top:6px;">${esc(label)}</div>
    </td>`;
  return `
  <tr><td style="padding:0 0 18px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
           style="background:${COLOURS.panel};border:1px solid ${COLOURS.line};border-radius:10px;">
      <tr>
        ${cell('Marks', `${esc(data.totalMarks ?? '—')}<span style="font-size:16px;color:${COLOURS.muted};font-weight:500;">/${esc(data.totalPossible)}</span>`, false)}
        ${cell('Grade', `<span style="color:${COLOURS.brand};">${esc(data.grade ?? '—')}</span>`, true)}
      </tr>
    </table>
  </td></tr>`;
}

/* ------------------------------------------------- editable wording ------ */

/**
 * The fixed wording of a feedback email. An admin can override any of these
 * from the Feedback page; the marks, grades and question breakdown are always
 * generated from the marksheet and are deliberately NOT editable.
 *
 * {placeholders} are filled in per pupil. Anything unrecognised is left alone,
 * so a stray brace in someone's wording cannot break the email.
 */
export const DEFAULT_EMAIL_TEXT = {
  pupil: {
    subject: 'Your {examName} results',
    greeting: 'Hi {firstName},',
    intro: 'Here are your results for {examName}. Below you can see how you did on each '
      + 'question, what went well, and the topics worth spending a bit more time on.',
    wwwHeading: 'What went well',
    ebiHeading: 'Even better if',
    focusHeading: 'Focus on',
    nothingFlagged: 'Nothing stood out as a particular strength or weakness this time — '
      + 'your marks were fairly even across the paper.',
    closing: 'If anything here does not make sense, ask your teacher in your next lesson — '
      + 'that is exactly what this feedback is for.',
    signOff: 'Best wishes,',
    signOffName: 'Your teacher',
  },
  parent: {
    subject: '{examName} — results for {fullName}',
    greeting: 'Dear Parent / Guardian,',
    intro: 'Here are {fullName}\'s results for {examName}, together with a breakdown of how '
      + 'they performed on each question. The sections below highlight where they did well '
      + 'and which topics would benefit from further practice at home.',
    wwwHeading: 'What went well',
    ebiHeading: 'Even better if',
    focusHeading: 'Focus on',
    nothingFlagged: 'No individual topics were flagged as particular strengths or weaknesses '
      + 'this time — performance was fairly even across the paper.',
    closing: 'If you would like to discuss these results, please contact the school in the usual way.',
    signOff: 'Best wishes,',
    signOffName: 'Your child\'s teacher',
  },
};

/** Human labels for the wording editor, in the order they appear in the email. */
export const FIELD_LABELS = {
  subject: 'Subject line',
  greeting: 'Greeting',
  intro: 'Opening paragraph',
  wwwHeading: '“What went well” heading',
  ebiHeading: '“Even better if” heading',
  focusHeading: '“Focus on” heading',
  nothingFlagged: 'Shown when nothing stands out',
  closing: 'Closing paragraph',
  signOff: 'Sign-off',
  signOffName: 'Signed by',
};

/** The values a {placeholder} can stand for, for one pupil. */
function placeholderValues(data) {
  const fullName = data.pupilName || 'Student';
  return {
    firstName: fullName.split(' ')[0] || fullName,
    fullName,
    examName: data.examName || 'Assessment',
    subject: data.subject || '',
    grade: data.grade ?? '—',
    totalMarks: data.totalMarks ?? '—',
    totalPossible: data.totalPossible ?? '—',
  };
}

/** Replace {placeholders} with this pupil's details. Returns raw, unescaped text. */
function fill(template, data) {
  const values = placeholderValues(data);
  return String(template ?? '').replace(
    /\{(\w+)\}/g,
    (match, key) => (key in values ? String(values[key]) : match),
  );
}

/**
 * The HTML form of a piece of wording.
 *
 * The template text is escaped FIRST and the placeholders substituted after,
 * so a teacher cannot put markup into an email, and a pupil whose name
 * contains a bracket cannot break the substitution.
 *
 * In editable mode each substituted value is wrapped in a marker span. That is
 * what lets the preview be edited directly: when the edited text is read back,
 * those spans turn into {placeholders} again, so editing an email that says
 * "Hi Amelia," does not save the literal name "Amelia" for the whole class.
 */
function fillHtml(template, values, editable) {
  return esc(String(template ?? ''))
    .replace(/\{(\w+)\}/g, (match, key) => {
      if (!(key in values)) return match;
      const value = esc(String(values[key]));
      return editable ? `<span data-qla-ph="${key}">${value}</span>` : value;
    })
    .replace(/\n/g, '<br>');
}

/** Merge the teacher's overrides over the defaults for one audience. */
function wordingFor(audience, overrides = {}) {
  return { ...DEFAULT_EMAIL_TEXT[audience], ...(overrides?.[audience] || {}) };
}

/* ------------------------------------------------------------------ render */

/**
 * @param {object} data   feedback payload (see js/feedback-engine.js)
 * @param {object} options { audience, schoolName?, text? }  text = wording overrides
 * @returns {{subject: string, html: string, text: string}}
 */
export function renderFeedbackEmail(data, options = {}) {
  const audience = options.audience === 'parent' ? 'parent' : 'pupil';
  const isParent = audience === 'parent';
  const name = data.pupilName || 'Student';
  const examName = data.examName || 'Assessment';
  const dateLine = formatDate(data.examDate);

  // Wording the admin may have changed, with {placeholders} filled in.
  const words = wordingFor(audience, options.text);
  const say = (key) => fill(words[key], data);
  const teacher = say('signOffName') || 'Your teacher';

  // `editable` is only ever true for the on-screen preview, never for a real
  // send. It adds the hooks the preview needs to be edited in place.
  const editable = Boolean(options.editable);
  const values = placeholderValues(data);
  const asHtml = (key) => fillHtml(words[key], values, editable);
  const edit = (key) => (editable ? ` data-qla-edit="${key}"` : '');

  const subject = say('subject');
  const greeting = asHtml('greeting');
  const intro = asHtml('intro');

  // Only reachable from Preview: a part-marked paper cannot be sent.
  const provisionalNote = !data.isComplete ? `
  <tr><td style="padding:0 0 16px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
           style="background:${COLOURS.weakBg};border:1px solid #fde68a;border-radius:10px;">
      <tr><td style="padding:12px 16px;font-size:13px;line-height:20px;color:#92400e;">
        <strong>Please note:</strong> ${esc(data.blankCount)} question${data.blankCount === 1 ? ' has' : 's have'} not been marked yet, so there is no total or grade for this paper.
      </td></tr>
    </table>
  </td></tr>` : '';

  const wwwTitle = say('wwwHeading');
  const ebiTitle = say('ebiHeading');
  const focusTitle = say('focusHeading');

  const wwwRows = bulletList(data.wentWell.map(esc), COLOURS.strong);
  const ebiRows = bulletList(data.evenBetterIf.map(esc), COLOURS.weak);
  const focusRows = bulletList(
    data.focusOn
      .map((item) => {
        const href = safeHref(item.url);
        if (!href) return '';
        const label = item.topic ? `${esc(item.topic)} — revision resource` : 'Revision resource';
        return `<a href="${esc(href)}" style="color:${COLOURS.brand};text-decoration:underline;">${label}</a>`;
      })
      .filter(Boolean),
    COLOURS.brand,
  );

  const noteBlock = (data.teacherNote || editable) ? `
  <tr><td style="padding:0 0 18px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
           style="border-left:3px solid ${COLOURS.brand};background:${COLOURS.panel};border-radius:0 10px 10px 0;">
      <tr><td style="padding:14px 18px;font-size:14px;line-height:22px;color:${COLOURS.body};">
        <span style="display:block;font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:${COLOURS.muted};padding-bottom:6px;">A note from ${esc(teacher)}</span>
        <span${editable ? ' data-qla-edit="teacherNote" data-placeholder="Add an optional note to the whole class…"' : ''}>${esc(data.teacherNote).replace(/\n/g, '<br>')}</span>
      </td></tr>
    </table>
  </td></tr>` : '';

  const nothingFlagged = !wwwRows && !ebiRows;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>${esc(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#eef2f7;-webkit-font-smoothing:antialiased;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(examName)}: ${esc(data.totalMarks ?? '—')}/${esc(data.totalPossible)}, grade ${esc(data.grade ?? '—')}.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#eef2f7;">
  <tr><td align="center" style="padding:24px 12px;">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"
           style="width:100%;max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 1px 3px rgba(15,23,42,.08);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">

      <tr><td style="background:${COLOURS.brandDark};padding:22px 28px;">
        <p style="margin:0;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#c7d2fe;">${esc(options.schoolName || data.subject || 'Assessment feedback')}</p>
        <h1 style="margin:6px 0 0 0;font-size:21px;line-height:28px;color:#ffffff;font-weight:600;">${esc(examName)}</h1>
        ${dateLine ? `<p style="margin:6px 0 0 0;font-size:13px;color:#a5b4fc;">${esc(dateLine)}</p>` : ''}
      </td></tr>

      <tr><td style="padding:26px 28px 4px 28px;">
        <p${edit('greeting')} style="margin:0 0 12px 0;font-size:16px;color:${COLOURS.ink};">${greeting}</p>
        <p${edit('intro')} style="margin:0 0 20px 0;font-size:15px;line-height:23px;color:${COLOURS.body};">${intro}</p>
      </td></tr>

      <tr><td style="padding:0 28px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          ${provisionalNote}
          ${scorePanel(data)}
          ${questionTable(data.rows)}
          ${section(asHtml('wwwHeading'), COLOURS.strong, COLOURS.strongBg, wwwRows, editable ? 'wwwHeading' : '',
            editable ? 'Topics this pupil did well on are listed here.' : '')}
          ${section(asHtml('ebiHeading'), COLOURS.weak, COLOURS.weakBg, ebiRows, editable ? 'ebiHeading' : '',
            editable ? 'Topics to work on are listed here.' : '')}
          ${section(asHtml('focusHeading'), COLOURS.brand, '#eef2ff', focusRows, editable ? 'focusHeading' : '',
            editable ? 'Reteach links for the weakest topics are listed here.' : '')}
          ${nothingFlagged || editable ? `
          <tr><td${edit('nothingFlagged')} style="padding:0 0 16px 0;font-size:14px;line-height:22px;color:${COLOURS.muted};">
            ${asHtml('nothingFlagged')}
          </td></tr>` : ''}
          ${noteBlock}
        </table>
      </td></tr>

      <tr><td style="padding:6px 28px 26px 28px;">
        <p${edit('closing')} style="margin:0;font-size:15px;line-height:23px;color:${COLOURS.body};">
          ${asHtml('closing')}
        </p>
        <p style="margin:16px 0 0 0;font-size:15px;color:${COLOURS.body};"><span${edit('signOff')}>${asHtml('signOff')}</span><br><strong${edit('signOffName')} style="color:${COLOURS.ink};">${asHtml('signOffName')}</strong></p>
      </td></tr>

      <tr><td style="background:${COLOURS.panel};border-top:1px solid ${COLOURS.line};padding:14px 28px;">
        <p style="margin:0;font-size:11px;line-height:17px;color:${COLOURS.muted};">
          This is an automated feedback email. Please do not reply to it directly unless your teacher's address is shown as the reply-to.
        </p>
      </td></tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;

  /* ---- plain-text alternative ---- */
  const lines = [];
  lines.push(say('greeting'));
  lines.push('');
  lines.push(say('intro'));
  lines.push('');
  if (!data.isComplete) {
    lines.push(`NOTE: ${data.blankCount} question(s) have not been marked yet, so there is no total or grade.`);
    lines.push('');
  }
  lines.push(`Total: ${data.totalMarks ?? '-'} out of ${data.totalPossible}`);
  lines.push(`Grade: ${data.grade ?? '-'}`);
  lines.push('');
  lines.push('QUESTION BY QUESTION');
  for (const row of data.rows) {
    const markText = row.mark === null ? 'not marked' : `${row.mark}/${row.outOf}`;
    lines.push(`  Q${row.number}${row.topic ? ` (${row.topic})` : ''}: ${markText}`);
  }
  if (data.wentWell.length) {
    lines.push('', wwwTitle.toUpperCase(), ...data.wentWell.map((t) => `  - ${t}`));
  }
  if (data.evenBetterIf.length) {
    lines.push('', ebiTitle.toUpperCase(), ...data.evenBetterIf.map((t) => `  - ${t}`));
  }
  if (data.focusOn.length) {
    lines.push('', focusTitle.toUpperCase(), ...data.focusOn.map((f) => `  - ${f.topic ? `${f.topic}: ` : ''}${f.url}`));
  }
  if (data.teacherNote) lines.push('', `A note from ${teacher}:`, data.teacherNote);
  lines.push('', say('signOff'), teacher);

  return { subject, html, text: lines.join('\n') };
}

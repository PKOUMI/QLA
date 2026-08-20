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

function section(title, accent, background, innerRows) {
  if (!innerRows) return '';
  return `
  <tr><td style="padding:0 0 16px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
           style="background:${background};border:1px solid ${COLOURS.line};border-radius:10px;">
      <tr><td style="padding:16px 18px;">
        <p style="margin:0 0 10px 0;font-size:12px;letter-spacing:.08em;text-transform:uppercase;font-weight:700;color:${accent};">${esc(title)}</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${innerRows}</table>
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
  const pct = data.percentage === null || data.percentage === undefined ? '—' : `${data.percentage}%`;
  const cell = (label, value, big) => `
    <td width="33.33%" align="center" style="padding:14px 8px;">
      <div style="font-size:${big ? '30px' : '26px'};line-height:1.1;font-weight:700;color:${COLOURS.ink};">${value}</div>
      <div style="font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:${COLOURS.muted};padding-top:6px;">${esc(label)}</div>
    </td>`;
  return `
  <tr><td style="padding:0 0 18px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
           style="background:${COLOURS.panel};border:1px solid ${COLOURS.line};border-radius:10px;">
      <tr>
        ${cell('Marks', `${esc(data.totalMarks)}<span style="font-size:16px;color:${COLOURS.muted};font-weight:500;">/${esc(data.totalPossible)}</span>`, false)}
        ${cell('Percentage', esc(pct), false)}
        ${cell('Grade', `<span style="color:${COLOURS.brand};">${esc(data.grade ?? '—')}</span>`, true)}
      </tr>
    </table>
  </td></tr>`;
}

/* ------------------------------------------------------------------ render */

/**
 * @param {object} data   feedback payload (see js/feedback-engine.js)
 * @param {object} options { audience: 'pupil' | 'parent', schoolName?: string }
 * @returns {{subject: string, html: string, text: string}}
 */
export function renderFeedbackEmail(data, options = {}) {
  const audience = options.audience === 'parent' ? 'parent' : 'pupil';
  const isParent = audience === 'parent';
  const name = data.pupilName || 'Student';
  const examName = data.examName || 'Assessment';
  const teacher = data.teacherName || 'Your teacher';
  const dateLine = formatDate(data.examDate);

  const subject = isParent
    ? `${examName} — results for ${name}`
    : `Your ${examName} results and feedback`;

  const greeting = isParent
    ? 'Dear Parent / Guardian,'
    : `Hi ${esc(name.split(' ')[0] || name)},`;

  const intro = isParent
    ? `Here are ${esc(name)}'s results for <strong>${esc(examName)}</strong>${data.subject ? ` in ${esc(data.subject)}` : ''}, together with a breakdown of how they performed on each question. The sections below highlight where they did well and which topics would benefit from further practice at home.`
    : `Here are your results for <strong>${esc(examName)}</strong>${data.subject ? ` in ${esc(data.subject)}` : ''}. Below you can see how you did on each question, what went well, and the topics worth spending a bit more time on.`;

  const provisionalNote = data.isProvisional ? `
  <tr><td style="padding:0 0 16px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
           style="background:${COLOURS.weakBg};border:1px solid #fde68a;border-radius:10px;">
      <tr><td style="padding:12px 16px;font-size:13px;line-height:20px;color:#92400e;">
        <strong>Please note:</strong> ${esc(data.blankCount)} question${data.blankCount === 1 ? ' has' : 's have'} not been marked yet, so ${isParent ? 'this total and grade are' : 'your total and grade are'} provisional.
      </td></tr>
    </table>
  </td></tr>` : '';

  const wwwTitle = 'What went well';
  const ebiTitle = 'Even better if';
  const focusTitle = 'Focus on';

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

  const noteBlock = data.teacherNote ? `
  <tr><td style="padding:0 0 18px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
           style="border-left:3px solid ${COLOURS.brand};background:${COLOURS.panel};border-radius:0 10px 10px 0;">
      <tr><td style="padding:14px 18px;font-size:14px;line-height:22px;color:${COLOURS.body};">
        <span style="display:block;font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:${COLOURS.muted};padding-bottom:6px;">A note from ${esc(teacher)}</span>
        ${esc(data.teacherNote).replace(/\n/g, '<br>')}
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
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(examName)}: ${esc(data.totalMarks)}/${esc(data.totalPossible)}, grade ${esc(data.grade ?? '—')}.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#eef2f7;">
  <tr><td align="center" style="padding:24px 12px;">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"
           style="width:100%;max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 1px 3px rgba(15,23,42,.08);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">

      <tr><td style="background:${COLOURS.brandDark};padding:22px 28px;">
        <p style="margin:0;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#c7d2fe;">${esc(options.schoolName || data.className || 'Assessment feedback')}</p>
        <h1 style="margin:6px 0 0 0;font-size:21px;line-height:28px;color:#ffffff;font-weight:600;">${esc(examName)}</h1>
        ${dateLine ? `<p style="margin:6px 0 0 0;font-size:13px;color:#a5b4fc;">${esc(dateLine)}</p>` : ''}
      </td></tr>

      <tr><td style="padding:26px 28px 4px 28px;">
        <p style="margin:0 0 12px 0;font-size:16px;color:${COLOURS.ink};">${greeting}</p>
        <p style="margin:0 0 20px 0;font-size:15px;line-height:23px;color:${COLOURS.body};">${intro}</p>
      </td></tr>

      <tr><td style="padding:0 28px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          ${provisionalNote}
          ${scorePanel(data)}
          ${questionTable(data.rows)}
          ${section(wwwTitle, COLOURS.strong, COLOURS.strongBg, wwwRows)}
          ${section(ebiTitle, COLOURS.weak, COLOURS.weakBg, ebiRows)}
          ${section(focusTitle, COLOURS.brand, '#eef2ff', focusRows)}
          ${nothingFlagged ? `
          <tr><td style="padding:0 0 16px 0;font-size:14px;line-height:22px;color:${COLOURS.muted};">
            ${isParent
              ? 'No individual topics were flagged as particular strengths or weaknesses this time — performance was fairly even across the paper.'
              : 'Nothing stood out as a particular strength or weakness this time — your marks were fairly even across the paper.'}
          </td></tr>` : ''}
          ${noteBlock}
        </table>
      </td></tr>

      <tr><td style="padding:6px 28px 26px 28px;">
        <p style="margin:0;font-size:15px;line-height:23px;color:${COLOURS.body};">
          ${isParent
            ? `If you would like to discuss these results, please contact ${esc(teacher)} through the school in the usual way.`
            : `If anything here doesn't make sense, ask ${esc(teacher)} in your next lesson — that's exactly what this feedback is for.`}
        </p>
        <p style="margin:16px 0 0 0;font-size:15px;color:${COLOURS.body};">Best wishes,<br><strong style="color:${COLOURS.ink};">${esc(teacher)}</strong></p>
      </td></tr>

      <tr><td style="background:${COLOURS.panel};border-top:1px solid ${COLOURS.line};padding:14px 28px;">
        <p style="margin:0;font-size:11px;line-height:17px;color:${COLOURS.muted};">
          This is an automated feedback email${data.className ? ` for ${esc(data.className)}` : ''}. Please do not reply to it directly unless your teacher's address is shown as the reply-to.
        </p>
      </td></tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;

  /* ---- plain-text alternative ---- */
  const lines = [];
  lines.push(isParent ? 'Dear Parent / Guardian,' : `Hi ${name.split(' ')[0] || name},`);
  lines.push('');
  lines.push(isParent
    ? `Here are ${name}'s results for ${examName}.`
    : `Here are your results for ${examName}.`);
  lines.push('');
  if (data.isProvisional) {
    lines.push(`NOTE: ${data.blankCount} question(s) have not been marked yet, so this total and grade are provisional.`);
    lines.push('');
  }
  lines.push(`Total: ${data.totalMarks} out of ${data.totalPossible}  (${data.percentage}%)`);
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
  lines.push('', 'Best wishes,', teacher);

  return { subject, html, text: lines.join('\n') };
}

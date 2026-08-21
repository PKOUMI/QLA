# Changelog

## v3 — change request of 21 August 2026

### Marksheet
- The mark grid now fills the window instead of sitting in a fixed box, and it
  is measured rather than guessed — how much room is left depends on the window
  size and on whether a set-up warning is showing, so it is worked out at
  render time and on resize.
- Rows are a single line: the pupil's email moved to the row's tooltip, with a
  warning icon where an address is missing. The page header, stats strip,
  column headers and legend were all tightened.
- Net effect on a 1400×800 laptop: **10 pupils visible at once, up from 2–4**,
  and the grid no longer runs off the bottom of the screen. On a 1080p display
  it is about 15.

### Feedback
- **Message options card removed.** The optional note to the class was inside
  it; rather than lose the feature, it moved into the email preview, where it
  is written directly onto the email in the place it will appear. The "also
  send to parents" toggle is gone too — the **Parents** column header checkbox
  already does exactly that job.
- **Send now sits above Who gets feedback.**
- **Parent email column added** to the table, beside the pupil email.
- **One "Preview and edit email" button** replaces the separate preview and
  wording buttons. It opens the real email, built from the first pupil's real
  marks, and the wording can be edited directly on it: click any highlighted
  text and type. Changes apply to every email in the assessment.
- Personal details are highlighted as chips in the preview. Editing an email
  that greets "Hi Amelia," saves `Hi {firstName},` and not Amelia's name — so
  the next pupil is still greeted by their own name. Tested explicitly.
- Both the pupil and parent versions are editable from the same screen, with
  the subject line above the preview.
- The preview iframe is sandboxed **without** `allow-scripts`, so nothing in an
  email can run. Editing is wired up from the page itself.

### The lock
- The PIN lock now covers **Set up and Feedback**. When locked, nobody can
  change who receives feedback, reword the email, or send it.
- Entering marks on the marksheet is still never affected.
- The lock bar appears on both pages and the same PIN unlocks both, from
  either page. The lock UI moved into `js/lockbar.js` so there is one
  implementation rather than two.
- While locked, the preview still opens — read-only, with no editing and a
  Close button. Looking at an email harms nothing.

### Data
- No schema change. Assessments saved by v2 load unchanged.

---

## v2 — change request of 21 August 2026

### Set up
- Removed the **Your name** and **Class** fields, and every use of them. The
  email sign-off is now editable wording rather than a name field, and the
  saved-assessments list shows the subject instead of the class.
- Validation warnings on the questions table (especially the reteach link) now
  appear only once you click or tab **away** from a field. A half-typed URL is
  no longer flagged as an error while you are still typing it.
- Grade boundaries are a **vertical list at every screen size**, highest grade
  first, the way exam boards publish them. The percentage hint has been replaced
  by the **mark range** each grade covers (e.g. "34 to 38 marks"), which also
  makes a gap or an overlap in the boundaries obvious.
- Pupils section has a **Clear all** button, and a note stating that importing a
  CSV adds to the list and never deletes pupils already entered. The existing
  duplicate handling is unchanged.
- New **Setup lock**: choose a PIN to freeze the questions, boundaries and pupil
  list while marks are being entered. Entering marks is unaffected. Only a
  salted SHA-256 of the PIN is stored, never the PIN. It is checked in the
  browser, so it deters accidents rather than a determined person — real staff
  permissions need the server, and the app says so rather than implying
  otherwise.

### Percentages
- Removed from grade boundaries, the marksheet, the feedback table, the CSV
  export and the emails. The app now reports **marks and grades only**.
- The one exception, as requested, is **"Marks entered"** at the top of the
  marksheet, which measures progress through marking rather than attainment.
- Proportions are still computed internally for the >80% / <25% feedback rules
  and for bar widths, but are never shown as a figure.

### Marksheet
- A pupil's **Total** and **Grade** now show a dash until every question on
  their paper has a mark. A part-marked paper scored against a full-paper
  boundary would read as a fail, so nothing is shown rather than something
  misleading.
- Such a pupil **cannot be selected for feedback**, and the unmarked-questions
  warning says exactly that.
- "Class average" is now **Class average marks**, and the percentage beside it
  has been replaced by **Class average grade**.

### Analyse (new — step 3; Feedback becomes step 4)
- A question table with class average, lowest, highest, how many are unmarked,
  and the reteach link for each question.
- Four charts, each of which can be hidden and each of which has a table view:
  **grade distribution** (bar or pie/donut), **topic / AO performance** (ranked
  weakest first, or strongest, or A–Z), **question averages**, and **mark
  distribution** with your grade boundaries drawn on.
- Your choices are saved with the assessment.

### Feedback
- New **Parents** column with its own tick per pupil, separate from the pupil
  tick — so a pupil can receive feedback while their parents deliberately do
  not. An individual exclusion always wins over the master switch.
- The **Also send feedback to parents** toggle ticks or clears that whole
  column.
- The **percentage column has been removed**.
- **Edit email wording**: change the subject line, greeting, opening paragraph,
  the three section headings, closing paragraph and sign-off, for the pupil and
  parent versions separately, with `{firstName}`, `{fullName}`, `{examName}`,
  `{grade}` and similar placeholders. Applies to every email in the assessment.
  Marks, grades and the question breakdown are always generated from the
  marksheet and cannot be edited. Available only when the Setup lock is
  unlocked, i.e. to the admin.
- Edited wording is validated and length-capped on the server, and HTML-escaped
  when rendered, so it cannot be used to inject markup into an email.

### Fixes found while testing
- `hidden` elements could still be visible where a component set `display`
  (this was showing the "Enter PIN to unlock" button when nothing was locked).
- Chart axes counting pupils were showing fractional ticks such as "0.75".
- The lock took effect one render late, so locking appeared to do nothing until
  you navigated away and back.

### Data
- Schema version 2. Existing saved assessments are migrated automatically on
  load: the removed fields are dropped and the new `settings` and `emailText`
  blocks are added with sensible defaults. Nothing needs re-entering.

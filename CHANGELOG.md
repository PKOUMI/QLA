# Changelog

## v5 — change request of 22 August 2026

### Marksheet
- **Fixed: the site header stayed hidden after pressing browser Back while the
  grid was expanded.** Full-window mode hides the header, and nothing was
  clearing it when the browser navigated away, so you landed on another page
  with no header and no way back short of reloading. Leaving the marksheet now
  always exits full screen — by Back, by Escape, by the Exit button, or by any
  in-app navigation. There is a second guard on `popstate` for browsers that
  navigate without firing a hash change, because a missing header is bad
  enough to be worth catching twice.
- Note that while expanded the step navigation is deliberately hidden. The ways
  out are **Exit full screen**, **Esc**, or browser Back — all three now behave.

### Email
- **The closing paragraph is gone**, in both the pupil and parent versions —
  "If you would like to discuss these results, please contact the school in the
  usual way" and its pupil equivalent. The email now runs from the feedback
  sections, through the optional message, straight to the sign-off. That
  leaves eight editable regions rather than nine.

### Sample data (new)
- A `sample-data/` folder with a full GCSE paper and a year group's marks, for
  testing the app as it would really be used.
- **GCSE Combined Science: Trilogy — Biology Paper 1**, Higher tier, 70 marks,
  30 questions numbered as on the real paper (`01.1`, `01.2`, `02.1`…), across
  9 topics, each with a reteach link.
- **90 pupils**, every mark entered, 10 with no parent address. Mean 37.5 out
  of 70, range 13–57, grades from U to 8 — a believable spread rather than
  random numbers, because each pupil has an ability and each question a
  difficulty.
- **Every email address is unreachable.** They end in `.invalid`, a top-level
  domain reserved by RFC 2606 that can never be registered and never resolves,
  so nothing can be delivered to a real person even by accident.
- Supplied as both a full assessment (`.json`, loaded via Assessments →
  Restore from backup) and a class list (`.csv`, for the CSV import), plus the
  generator script so the class can be changed or rebuilt.
- Worth knowing before testing sends: those addresses will all **fail**, which
  is the point — it exercises the failure reporting. Send a handful at a time
  rather than all 170, since hard bounces count against a sending reputation.
  `sample-data/README.md` covers this.

### Found while building the sample data
- The app's own duplicate-email check caught two colliding addresses in the
  first draft of the class (two pupils sharing a surname and initial). The
  generator now breaks the tie with a number, the way a school MIS does. Good
  sign for the validation.

---

## v4 — change request of 21 August 2026

### Marksheet
- **Expand button.** The grid takes over the whole window — page header, page
  title and surrounding cards all step aside, and the stats compress to a
  single line. **Exit full screen**, or just press `Esc`, brings it back.
  On a 1280×610 laptop that is **11 pupils on screen at once**.
- The normal view got taller too. On short screens the page title's
  explanation, the stats padding and the legend all shrink automatically, and
  the measured gap below the grid was tightened. Same laptop: **7 rows, up
  from about 4**.

### Feedback
- Page order is now **Preview and edit email → Who gets feedback → Send**.
- **The confirmation dialog now always appears.** It was being skipped when no
  email backend was configured, because the app bailed out before asking. The
  check now happens after you confirm, so pressing Send always asks first and
  then tells you honestly what happened.
- The dialog itself is more explicit: how many pupils, how many parents, how
  many emails, and that emails cannot be recalled.

### The email
- **The "a note from your teacher" block is gone.** In its place is a single
  optional message, sitting straight after **Focus on**. Write in it or leave
  it empty; when it is empty the email simply has nothing there — no heading,
  no border, no empty box. Any note you had already written is carried across
  automatically.
- The "nothing stood out this time" line is no longer separately editable, so
  there is now exactly one editable box after Focus on, as asked.

### Editing one pupil's email
- **View** in a pupil's row now opens that pupil's own email, and anything
  changed there applies **to that pupil alone**.
- The scope is stated in three places: a note under the table, a note on the
  Preview card, and a banner inside the dialog itself — amber for one pupil,
  blue for the whole class. The save button names the pupil too
  ("Save for Amelia only").
- Pupils with their own wording get an **own wording** badge in the table and
  are listed on the Preview card, so it is obvious who has been customised.
- **Use the class wording** puts an individual pupil back to the standard text.
- Editing the class-wide wording does not overwrite a pupil who has their own.
- Per-pupil wording travels with the send, so an individually edited email is
  delivered exactly as previewed.

### Data
- Schema version 3. Assessments saved by v2 or v1 load unchanged; the old
  teacher note becomes the new optional message.

---

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

## Sign in

Teachers sign in with their school email address and a six-digit code. No
passwords, and nothing for an administrator to create by hand.

- **New:** `js/auth.js` — the sign-in screen, the "you are signed in as"
  strip in the header, and sign out.
- **New:** `supabase/migrations/0002_access.sql` — the staff list, the
  Before User Created hook that refuses an address nobody has added, and the
  two routes that turn an invitation into a membership.
- **New:** `supabase/seed/first-school.sql` — creates the school and its owner.
- **New:** `tests/browser/` — the sign-in screen driven in a real Chromium,
  with a stand-in Supabase. 24 checks. `npm run test:browser`.
- **Changed:** the app now waits for a signed-in teacher before loading, but
  only when `config.js` has database details. Without them it still runs
  entirely in the browser, which is what the public demo does.
- **Changed:** `window.__QLA_BOOTED` is set before the sign-in screen appears,
  not after the app loads. Somebody waiting for a code to arrive would
  otherwise have the deployment-error banner thrown over the top of it.
- **Changed:** the app is called EveryPupil in the header and the title bar,
  which is what the sign-in screen says and what the domain says.
- **Fixed:** `tests/security.sql` was five separate statements, and the
  Supabase SQL Editor only shows the last one. Four checks were running and
  being discarded. Now one query, seven rows.
- **Fixed:** the code box assumed six digits. GoTrue's OTP length is a server
  setting and some projects send eight — and `maxlength="6"` made the last two
  physically untypeable. It now accepts six to ten and lets the server judge.
  Typing no longer auto-submits, because firing at six digits would spend an
  attempt on a truncated eight-digit code; pasting still does, since a pasted
  code is a whole one.

## Roles

`teacher` no longer means "can do everything except manage staff".

- **New:** `supabase/migrations/0003_roles.sql`. A teacher enters marks and
  reads the school's assessments and analysis. Creating or editing a paper,
  managing pupils, and sending feedback are an admin's.
- **New:** `assessment_teachers` — which staff are marking which paper. A
  teacher can only write marks on an assessment they have been assigned to, so
  a mistake can only ever land on their own paper.
- **New:** `school_staff()` — lists colleagues for the "who is marking this?"
  screen. SECURITY DEFINER, because listing them reads `auth.users`.
- Every table now has a read policy the whole school passes and a write policy
  only the right role passes. Permissive policies OR together, so the read
  policy never grants a write.

## Marks live in the database

The work no longer sits in one browser. A marksheet started in a classroom can
be finished in the staffroom a week later, on a different computer.

- **New:** `js/storage-supabase.js`. Same four methods the rest of the app
  already used, so no view changed.
- **Saves a difference, not a document.** Each save works out what actually
  changed and sends only that. A class of 90 on a 40-question paper is 3,600
  marks; typing one number now sends one row. Verified: one changed mark, one
  write.
- **Two teachers marking the same paper no longer overwrite each other.**
  Because only changed cells are sent, their edits merge.
- **Marks are written before anything else**, so a teacher who touches
  something an admin owns still keeps the marks they were entitled to enter.
  On a first save the order reverses, because a mark cannot reference a paper
  that does not exist yet.
- **New:** `js/roles.js` — a teacher sees the setup and feedback pages as read
  only, with a line saying who to ask. Not a permission: the permissions are in
  Postgres either way. This just stops somebody filling in a form for ten
  minutes before being told it was never theirs.
- **Client ids are now UUIDs**, so a question has the same identity in the
  browser and the database from the moment it is created.
- Assessments already saved in a browser are given UUIDs on first save, marks
  and feedback selections following along, rather than being stranded.
- A teacher with nothing assigned is told so, instead of being shown an empty
  form the database would refuse to save.
- **New:** `tests/storage.test.mjs` — 23 checks against a real PostgreSQL with
  the real policies applied, so "a teacher cannot change the paper" is answered
  by Postgres rather than by a mock.

## Staff, and who marks what

The two jobs that still needed the SQL editor now have screens.

- **New:** **Staff** in the header. Everyone at the school, what they may do,
  and — the column that answers the question an admin actually has — whether
  they have ever signed in, or are still sitting on an email they have not
  opened.
- **New:** **Who is marking this paper**, on the setup page. Tick the staff who
  will enter marks. Saved the moment a box is ticked, like everything else
  here; a screen with a Save button would be the one that loses work.
- **New:** `supabase/migrations/0004_staff.sql`. Adding, changing and removing
  staff go through database functions rather than table writes, because the
  rules that matter are not per-row rules: a school must never be left without
  an owner, an admin must not be able to demote the person who appointed them,
  and you should not be able to remove yourself by accident. Each refusal is
  written to be read by the person who tried.
- Removing somebody takes them off every paper they were marking. Their marking
  stays: the work belongs to the school, and removing a colleague should never
  quietly delete a term of marks.
- Someone invited but not yet signed in appears on the staff list, greyed out
  in the marker list, because there is no account to attach to a paper yet.
- **Fixed:** the header could not hold a school name, an email address and a
  Sign out button as well as everything already in it, and pushed the page
  sideways. It now sheds the school name, then the step labels, then the email
  as the window narrows. Checked at five widths.

## Three changes

- **Removed:** the PIN lock. What somebody may change is decided by their role
  now, which is stronger than a PIN a department shares and stops nobody. Both
  lock bars, `js/lock.js` and `js/lockbar.js` are gone. Editing the feedback
  wording follows the same rule as everything else: admins only.
- **Changed:** the header carried a school name, an email address and a Sign
  out button, and ran out of room. All three now live inside one round account
  button in the corner, which also shows the role and what it allows.
- **Changed:** the Analyse page had a "Question averages" bar list sitting
  above a "Question breakdown" table repeating the same numbers. Reading it
  meant looking a question up twice. One card now, full width, in the style of
  the bar list, with lowest, highest, how many got full marks, how many scored
  nothing, and the reteach link under each bar. The table view keeps every
  column.
- **New:** `questionAverages` counts how many pupils got full marks and how
  many scored nothing. A first attempt drew the lowest-to-highest range as a
  band behind each bar; on a real class of 90 it filled the whole track every
  time, because somebody always scores nothing and somebody always gets full
  marks. It looked like information and carried none, so it went.

## Sending needs no setting up

- **Removed:** the Settings screen, and the shared access key with it. Both
  were a hangover from before there were accounts: every teacher had to be
  given an address and a secret to paste into their own browser, and a teacher
  on a new laptop was a teacher who could not send.
- **Changed:** the email service address is set once in `config.js` when the
  app is deployed. Teachers are never asked for it.
- **Changed:** the API now authenticates the caller by the session they already
  have from signing in, checked against Supabase (`api/_lib/session.js`).
  Access ends the moment somebody is removed from the school's staff list —
  which a shared key could never do. Needs `SUPABASE_URL` and
  `SUPABASE_ANON_KEY` on the API deployment.
- If those variables are missing the server refuses every send. An
  unconfigured door is a locked door, not an open one — the old shared-key
  check treated "not configured" as "no key required".
- **New:** `supabase/tests/installed.sql` — reports which migration files have
  been run against a project and which have not, and refreshes PostgREST's
  schema cache. Written after "Could not find the function
  public.invite_staff(...) in the schema cache", which reads like an internal
  fault and is almost always a migration nobody has run yet.
- **Changed:** the app now says that in plain words instead of passing the
  database's phrasing through.

## Marks, and three smaller things

- **Changed:** a mark that cannot be right now leaves the box **blank**. It
  used to put back whatever was there a moment before, which is worse than it
  sounds: type 33 into a 6-mark question that already said 3, and you are
  looking at a 3 you did not just enter. Any value the app picks — the maximum,
  or the previous mark — is indistinguishable from one a teacher typed, and
  would go out to a child in a feedback email. Blank is the one state the app
  already makes loud.
- The message now names the number typed and how many marks the question is
  worth, rather than "Maximum for this question is 6" with no indication of
  which cell is complaining.
- **New:** `tests/browser/marksheet.test.mjs` — 18 checks in a real browser
  against the 90-pupil sample, including that a zero is still stored as a zero
  and a half mark still works.
- **Changed:** the account menu lists the school on its own line.
- **Removed:** "always 0" beside the U grade boundary.
- **Docs:** the `{{ .Token }}` block goes in **Confirm signup** as well as
  **Magic link**. A new colleague's first sign-in creates their account, so it
  is the signup template they see — and if it has not been edited they get a
  confirmation link that goes nowhere, then a working code on the second
  attempt, which looks like an intermittent fault rather than a missing
  template.

## A teacher's marks always land

Reported from a real department: a teacher enters a mark, is told "Your marks
were saved, but changing this assessment needs an admin", and the mark is not
in the database.

- **Changed:** when the signed-in person is a teacher, a save carries **marks
  and nothing else**. Their copy of an assessment can differ from the database
  in ways they never asked for — a field normalised on load, a default filled
  in by a newer version — and any one of those turned their next mark entry
  into a request the database was right to refuse. The refusal then landed on
  the teacher, about a change they had not made. Postgres is still the
  authority; the app simply no longer asks for what is not its to ask.
  Anything dropped is named in the browser console, because a document
  changing when nobody asked it to is worth knowing about.
- **Fixed:** the message shown when *marks themselves* are refused began "Your
  marks were saved, but…". A teacher reads the first clause, believes their
  marking is safe, and closes the tab. It now says the marks were **not**
  saved and who to ask.
- **New:** `tests/browser/teacher-marking.test.mjs` — the whole path in one
  test: an admin builds a paper through the setup screen, assigns a marker
  through the marker list, the teacher signs in on their own machine, enters a
  mark, and the admin opens the paper and sees it. Real browser, real
  PostgreSQL, real policies. Twelve checks, including a teacher whose document
  has drifted.
  Everything underneath this already passed while the app itself did not work
  for a teacher. That is what was missing.
- **Fixed (test harness):** the stand-in PostgREST did not answer CORS
  preflights, so a cross-origin browser blocked every request before it was
  sent — which looks exactly like a permissions problem and is not one.

## A page that says what is actually happening

- **New:** `diagnose.html`, at `/diagnose.html` on the deployed site. It asks
  the database the same questions the app asks, one at a time, and reports
  exactly what comes back: whether the app knows where the database is,
  whether the session is accepted, which school the account is linked to, what
  that assessment actually contains in the database, and — the one that
  matters — whether a write reaches it and can be read back. It writes a mark
  into an empty cell and removes it again, so nothing is left behind.
  There is a Copy button, and the report carries no pupil names and no marks.
  Written after a second round of "it isn't saving" that could not be
  reproduced here. Guessing twice is one time too many.

## Which paper am I on?

The app never said. Two colleagues could be on two different assessments, each
seeing an empty marksheet where the other saw marks, and reasonably conclude
the app was losing work.

- **Changed:** the header button now carries the **name of the open
  assessment** instead of the word "Assessments", and clicking it still
  switches. The marksheet heading reads "Marks — <name>".
- **Changed:** the connection check lists **every** assessment separately, with
  its question, pupil and mark counts, when a mark was last entered, and which
  one the app would open. That is the question worth asking when marking
  appears to have vanished.

## The 1,000-row ceiling

The cause of "it isn't saving": it was saving. It was not *reading*.

Supabase returns at most **1,000 rows** per request and says nothing when it
truncates — you get exactly 1,000 rows and a 200. A class of 90 sitting a
30-question paper is 2,700 marks, so a marksheet had been arriving with a
third of its marking and the rest showing blank. The connection check reported
"1000 marks stored", which was the ceiling wearing the costume of a fact.

- **Fixed:** every read is now made in pages until a page comes back short.
  The page size is taken from what the **first response actually contained**,
  not from what was asked for, because the server applies its own cap
  silently — asking for 1,000 and receiving 500 means the ceiling is 500, and
  treating that as the end of the data is how this happened.
- Paging needs a deterministic sort or two pages can repeat one row and skip
  another, so a second page without one is refused rather than returned as
  though it were complete. Every call site now names its order.
- **Fixed (test harness):** the stand-in PostgREST did not cap responses, so it
  cheerfully returned 2,700 marks that the real thing would have cut to 1,000.
  It now caps like Supabase, and the cap is configurable — the suite is run at
  7, 100 and 1,000 rows to prove the paging is not merely correct at one
  convenient number.
- **New:** a 1,200-mark assessment is written, read back, and re-saved, with
  every mark checked. This is the test that would have caught it.
- **Fixed:** the connection check asked for the newest mark by sorting a page
  of marks it had already been given — which, capped, usually did not contain
  the newest one. That is why the time never moved. It now asks the database
  for it directly.
- **Changed:** the end-to-end test waits for the database rather than sleeping
  a fixed number of milliseconds. Four consecutive clean runs.

## Branding, and a night mode

- **New:** a palette built for the third hour of marking. A desaturated teal
  on a ground that is never pure white; the strongest contrast on the page is
  16:1 rather than the 21:1 of black on white, which is past the comfortable
  range for continuous reading. Every pair still meets WCAG AA — comfortable
  is not the same as washed out, and a misread digit is a mark entered wrong.
  Checked with a script, not by eye.
- **New:** night mode, and it is not an inversion. Inverting a light theme
  gives white text on black, which haloes at length. Night is a very dark
  green-grey ground (0.7% luminance, not 0%) with off-white text. The header
  button cycles: match my computer → day → night, kept per browser because a
  bright classroom and a dark front room want different answers.
- The theme is applied in `<head>` before the stylesheet, so a night user
  never sees a white flash on the way in.
- Toasts have their own ground and text colour per theme. A bright rectangle
  sliding into the corner of a dim room is exactly the jolt the palette exists
  to avoid.
- **New:** `brand/` — the mark in SVG, mono, two lockups, and PNGs from 32 to
  1024. Four bars, deliberately uneven: a neat ascending ramp says "numbers
  went up", and this is about every pupil having done something different.
- Applied to the app, the feedback email, the marketing site, and both
  documents in `docs/`.

## Marketing page, corrected

- **Removed:** "Lock the paper while marking". The PIN lock no longer exists.
  Replaced with roles, which is what actually protects a paper now.
- **Fixed:** the FAQ still described locking an assessment with a PIN.
- **New:** "Built for the third hour of marking" — the eye-comfort work as a
  feature, since it is one.
- **New:** "Start in the classroom, finish in the staffroom" — marks held for
  the school, two people marking at once, and signing in with an emailed code
  rather than a password.
- **New FAQ:** how teachers sign in, and what happens to their access when
  they are removed from the staff list.

## Marksheet

- **Fixed:** the wheel changed the mark under the pointer. Scrolling to find a
  pupil is the reason anybody touches the wheel on a marksheet, and the cost
  of the old behaviour was a silently altered mark on a real child's paper.

# Question Level Analysis (QLA) — Architecture

_Stage 1 of the build. Read this before the code._

---

## 1. The one constraint that shapes everything

GitHub Pages serves **static files only**. Every byte it sends is readable by anyone
who presses `Ctrl+U` or opens DevTools. There is no server, no environment
variables, no secrets.

An email API key is a bearer credential: whoever holds it can send email as you,
consume your quota, and — because the mail arrives DKIM-signed by your domain —
damage the sending reputation of your domain permanently.

So the rule is absolute:

> **Nothing that must stay secret may ever be part of the front end.**

That single fact splits the product into two deployables:

| Piece | What it is | Where it lives | Can it hold secrets? |
|---|---|---|---|
| **Front end** | HTML/CSS/JS, runs in the teacher's browser | GitHub Pages | **No** |
| **API** | One serverless function that sends email | Vercel | **Yes** |

Everything else in this document follows from that table.

---

## 2. Recommended architecture (MVP)

```
                    Teacher's browser
        ┌────────────────────────────────────────┐
        │  QLA front end (HTML / CSS / vanilla JS)│
        │                                         │
        │   Setup ──> Marksheet ──> Feedback      │
        │        │                        │       │
        │        └──> localStorage <──────┘       │
        │             (assessment JSON)           │
        └───────────────────┬─────────────────────┘
                            │  HTTPS POST
                            │  structured JSON — NOT rendered HTML
                            │  (pupil name, marks, topics, links)
                            ▼
        ┌────────────────────────────────────────┐
        │  Vercel serverless function             │
        │  /api/send-feedback                     │
        │                                         │
        │  1. CORS allowlist check                │
        │  2. Shared-secret header check          │
        │  3. Rate limit (per IP)                 │
        │  4. Idempotency check (dedupe sends)    │
        │  5. Validate + sanitise every field     │
        │  6. RENDER the email HTML here          │
        │  7. Send via Resend, with retries       │
        │  8. Return honest per-recipient results │
        │                                         │
        │  RESEND_API_KEY lives here only         │
        └───────────────────┬─────────────────────┘
                            │
                            ▼
                      Resend API  ──>  Pupil / parent inboxes
```

### Why the server renders the email, not the browser

The obvious design is "browser builds the HTML, server just posts it to Resend."
Do not do that. It turns your endpoint into an **open mail relay**: anyone who
finds the URL can send arbitrary HTML from your verified domain — phishing,
spam, anything. Your domain gets blocklisted and every school that has ever
allowlisted you stops receiving your mail.

Instead the browser sends *structured data* (`{ pupilName, mark, outOf, topics[] }`)
and the server renders it into a fixed template it controls. The worst an abuser
can do is send a badly-worded exam-results email. The same template module is
imported by the browser for the **preview** screen, so preview and reality cannot
drift apart.

---

## 3. Email provider — why Resend

| | Resend | Postmark | SendGrid | Amazon SES |
|---|---|---|---|---|
| Free tier | 3,000/mo, 100/day | 100 trial only | 100/day | 3,000/mo (from EC2) |
| API simplicity | Excellent | Good | Fair | Poor (SigV4) |
| Setup time | ~15 min | ~20 min | ~40 min | Hours + approval |
| EU/UK data region | Yes (Ireland) | US only | US/EU | Yes (eu-west-2 London) |
| Cost at 50k/mo | ~$20 | ~$55 | ~$60 | ~$5 |
| Batch endpoint | Yes (100/call) | Yes | Yes | Yes |

**Recommendation: Resend**, for these reasons in this order:

1. **EU data region.** You will be processing UK schoolchildren's names and email
   addresses. Being able to say "our email processor stores data in Ireland" is a
   real answer to a real question a school Data Protection Officer will ask. This
   is the single biggest differentiator for your use case.
2. **The free tier actually covers your prototype.** 3,000 emails/month is roughly
   a full teaching timetable's worth of feedback. You can test with real classes
   before spending anything.
3. **The API is one HTTP POST with a JSON body.** No SDK required, no signing
   algorithm, no webhook handshake. Less code means fewer places for a bug to
   leak pupil data.
4. **It scales.** $20/mo covers 50,000 emails — comfortably a multi-school
   deployment. If you ever outgrow it, SES is the cost-optimised end state and
   the swap is confined to one file (`api/_lib/mailer.js`).

Amazon SES is genuinely the cheapest and has a London region, and is the right
answer *later*, at volume. It is the wrong answer now because production access
requires a written application to AWS describing your bounce-handling process,
and you'd spend your first week on IAM policies instead of on the product.

The code isolates the provider behind a small `sendOne()` function, so switching
later is a contained change.

---

## 4. What can be pure HTML/CSS/JS, and what cannot

**Works perfectly as static front end (this is most of the product):**

- Creating an assessment, questions, max marks, topics, reteach links
- Total-marks calculation
- Grade boundary entry and validation
- Adding pupils manually
- CSV template download and CSV import + validation
- The whole marksheet: entry, per-cell validation, totals, grades
- The whole Analyse page, including every chart (hand-written SVG, no library)
- Question averages
- What Went Well / Even Better If / Focus On calculation
- Email preview
- Saving and reloading work (localStorage)
- Exporting to CSV

**Requires a server — no exceptions:**

| Feature | Why |
|---|---|
| Sending email | API key must stay secret |
| User accounts / login | Password checks must happen where the user can't edit them |
| Subscriptions / Stripe | Secret key; webhooks need a public endpoint |
| Shared/school data | Needs a database |
| Usage limits & quotas | A client-side limit is a suggestion, not a limit |
| Audit logs | Must be tamper-proof |

I have not faked any of the server column. Where the app needs the backend, it
calls the backend and reports honestly if it isn't configured.

---

## 5. Data storage: is localStorage enough for v1?

**Yes, for a single teacher on a single machine — and no further.**

What it gives you: the teacher can set up an assessment, enter marks, close the
laptop, reopen it tomorrow and carry on. That is the entire requirement for an MVP.

What you must know about its limits before you rely on it:

| Limitation | Consequence for a teacher |
|---|---|
| Per-browser, per-device | Marks entered on the classroom PC are not on their laptop |
| Cleared by "clear browsing data" | Silent total data loss |
| ~5 MB cap | Fine (an assessment is ~50 KB), but not unlimited |
| Not backed up | One broken laptop = one lost set of marks |
| Synchronous | Irrelevant at this size |

Mitigations built into the MVP: **Export to JSON** (a real backup file the
teacher can keep), **Import from JSON**, and a visible "last saved" indicator so
they can trust it.

The code is written so this is replaceable. All persistence goes through
`js/storage.js`, which exposes an async repository interface:

```js
await repo.list()            // -> [{id, name, updatedAt}]
await repo.get(id)           // -> Assessment
await repo.save(assessment)  // -> Assessment
await repo.remove(id)
```

Every method is `async` **even though localStorage is synchronous**. That is
deliberate: when you swap in Supabase, no calling code changes. Replacing the
adapter is a ~60-line file, not a rewrite.

---

## 6. Security and privacy — honest assessment

This app handles children's names and email addresses. Under UK GDPR that is
personal data, and because it concerns children it attracts extra scrutiny
(ICO Age Appropriate Design Code).

### What the MVP does

- No pupil data leaves the browser except at the moment of sending
- The API stores nothing — it renders, sends, returns, forgets
- All output is escaped before it reaches HTML (XSS prevention) in both browser and email
- CSV import is parsed as data, never evaluated; formula-injection characters
  (`=`, `+`, `-`, `@`) are neutralised on export
- CORS allowlist: only your own origins may call the API
- Shared-secret header so the endpoint isn't world-callable
- Per-IP rate limiting
- Idempotency keys so a double-click cannot double-send
- Recipient count and payload size capped per request

### What is NOT true yet — do not claim otherwise

- **This is not GDPR compliant.** No software is "GDPR compliant" by itself;
  compliance is a property of your organisation and its documentation.
- The shared secret is stored in the teacher's browser. It is a speed bump against
  casual abuse, **not authentication**. Anyone with DevTools open can read it.
- The rate limiter and idempotency store are in serverless memory. They reset
  when the function cold-starts and are not shared between instances.
- There is no login, so there is no authorisation model and no audit trail.

### Required before a real school uses this commercially

1. **Real authentication** (Supabase Auth / Clerk / Auth0) — every API call
   carries a verified user token, not a shared secret.
2. **Row-level authorisation** — a teacher can only ever read their own classes.
   With Supabase this is Postgres Row Level Security, enforced by the database.
3. **Durable rate limiting and idempotency** — Upstash Redis or a Postgres table.
4. **A Data Processing Agreement (DPA)** you can hand to a school's DPO, naming
   every sub-processor (Vercel, Resend, Supabase) and where each stores data.
5. **Data residency decisions** — pin Supabase to `eu-west-2` (London) and Resend
   to its EU region. Vercel functions should be pinned to `lhr1`/`fra1`.
6. **Retention and deletion** — a documented policy plus a working "delete this
   class" that actually deletes, including from backups within a stated window.
7. **A privacy notice** written for schools, plus a pupil-facing one.
8. **DPIA (Data Protection Impact Assessment)** — processing children's data at
   scale effectively requires one. Schools will ask to see it.
9. **Penetration test / security review** before any multi-tenant launch.
10. **Sub-processor breach-notification chain** and an incident response plan.
11. **Cyber Essentials certification** — many MATs now require it of suppliers.
12. Consider signing the **DfE Data Protection Toolkit** expectations, and note
    that in most cases the *school* is the data controller and you are the
    *processor*. Your contract must say so.

Get a solicitor with edtech experience to review the DPA and terms before you
take money. This is cheaper than getting it wrong.

---

## 7. Domains: marketing site vs app vs API

Yes, the three-way split is the right approach, and it is what nearly every SaaS
does. The reasons are practical rather than aesthetic:

| Host | Purpose | Deployed to | Why separate |
|---|---|---|---|
| `example.com` | Marketing: what it does, pricing, sign-up | Static host / Framer / Webflow | Marketing changes weekly; you don't want to redeploy the app to fix a typo. Also needs to be SEO-indexed — the app must not be. |
| `app.example.com` | The application itself | GitHub Pages now, Vercel later | Isolated origin: an XSS on the marketing blog cannot touch app cookies or localStorage. Lets you put the app behind auth wholesale. |
| `api.example.com` | The backend | Vercel | Independent scaling and deploys; clean CORS boundary; you can version it (`/v1/`) without touching the app. |

One important subtlety: browser storage is **per-origin**. `example.com` and
`app.example.com` are different origins, so the app's data is invisible to the
marketing site. That's a security feature, not a problem.

You do **not** need three domains — one domain and three subdomains, which cost
nothing extra.

---

## 8. Commercial roadmap: Prototype → MVP → Beta → SaaS

### Phase 0 — Prototype (this build)
Front end on GitHub Pages, one Vercel function, Resend, localStorage.
No accounts, no payments, no database. **Cost: £0 + domain.**

**Goal: find out whether teachers actually use it.** Give it to five colleagues.
The only question that matters is whether they use it for a second assessment
without being asked.

### Phase 1 — MVP (once teachers keep using it)
Add, in this order:

1. **Accounts** — Supabase Auth, magic link (teachers hate passwords). ~2 days.
2. **Database** — Supabase Postgres, London region, Row Level Security on day one.
   Move localStorage into it via the existing repository interface. ~3 days.
3. **Multiple saved assessments + history** — nearly free once you have a database.
4. **Reusable classes** — the single biggest time-saver; a teacher enters a class
   once and uses it all year. Rank this above everything cosmetic.

**Cost: ~£0–25/mo.**

### Phase 2 — Beta
5. Real rate limiting (Upstash Redis) and per-account send quotas.
6. Error monitoring (Sentry) and uptime monitoring (Better Stack).
7. Automated backups: Supabase daily PITR, plus a nightly dump to object storage.
8. CSV/Excel export and PDF reports.
9. Legal pack: privacy notice, DPA template, terms, DPIA.

Run a free beta with 20–50 teachers across 3–5 schools. Charge nothing. Fix what
breaks. This phase is where you learn whether schools will buy centrally or
whether teachers buy individually — and that determines your pricing model.

### Phase 3 — Paid SaaS
10. **Stripe Billing**, using Stripe Checkout and the Customer Portal so you never
    handle card data or build billing UI. Webhook → Vercel function → set
    `subscription_status` in Postgres. Enforce limits server-side.
11. Tiers: something like Free (2 assessments/mo), Teacher (~£4/mo), Department
    (~£15/mo), School (site licence, invoiced — schools pay by invoice and
    purchase order, not card; build for this).
12. School accounts, admin roles, school-wide dashboards, branding.
13. Custom email templates and question banks.

### Suggested future stack

| Concern | Choice | Why |
|---|---|---|
| Auth | Supabase Auth (magic link) | Same vendor as DB; RLS reads the JWT directly |
| Database | Supabase Postgres, `eu-west-2` | UK residency; RLS is real authorisation |
| Hosting (app) | Vercel | Same place as the API once you outgrow Pages |
| API | Vercel Functions, `lhr1` region | Keeps pupil data in the UK |
| Email | Resend (EU region) → SES at volume | Behind one interface either way |
| Payments | Stripe Billing + Checkout + Portal | Handles VAT/MOSS, invoices, dunning |
| Monitoring | Sentry + Better Stack | Free tiers are sufficient for years |
| Backups | Supabase PITR + nightly dump to R2/S3 | A backup you haven't restored isn't a backup — test it |

### What to deliberately NOT build yet

Multi-school dashboards, custom branding, an analytics suite, question banks, a
mobile app, and an integration with SIMS/Arbor. Every one of these is a
reasonable idea and every one of them is a way to spend three months not finding
out whether teachers want the core product. Build them when a paying customer
names them.

---

## 9. Data model (Stage 2)

One JSON document per assessment. Deliberately flat and boring so it maps cleanly
onto Postgres tables later (the table split is noted against each part).

```jsonc
{
  "schemaVersion": 3,
  "id": "asmt_lz3k9x2p",              // -> assessments.id
  "createdAt": "2026-08-20T10:00:00Z",
  "updatedAt": "2026-08-20T10:42:11Z",

  "exam": {                            // -> assessments.*
    "name": "Autumn Term Maths Assessment 1",
    "subject": "Mathematics",
    "teacherEmail": "a.okafor@school.sch.uk",   // used as Reply-To
    "date": "2026-09-24",
    "paperType": "higher",             // "foundation" | "higher"
    "blankPolicy": "incomplete"        // "incomplete" | "zero"  (see §10)
  },

  "questions": [                       // -> questions (assessment_id FK)
    {
      "id": "q_1",
      "number": "3a",                  // TEXT, not a number: "3a", "4(ii)"
      "maxMarks": 5,                   // number > 0
      "topic": "Algebra",
      "reteachUrl": "https://..."      // optional, http(s) only
    }
  ],

  "gradeBoundaries": [                 // -> grade_boundaries
    { "grade": "U", "minMark": 0 },    // ascending; U is always 0 and locked
    { "grade": "3", "minMark": 25 }
  ],

  "pupils": [                          // -> pupils (or students table, reusable)
    {
      "id": "p_1",
      "name": "John Smith",
      "email": "john@example.sch.uk",  // optional but needed to send
      "parentEmail": ""                // optional
    }
  ],

  "marks": {                           // -> marks (pupil_id, question_id, mark)
    "p_1": { "q_1": 4, "q_2": null }   // null = NOT MARKED, distinct from 0
  },

  "feedback": {                        // -> assessment settings
    "sendToParents": false,            // master switch for the Parents column
    "selectedPupilIds": ["p_1"],
    "parentSelectedPupilIds": ["p_1"]  // separate, so a pupil can be emailed
                                       // while their parents deliberately are
                                       // not (safeguarding)
  },

  "settings": {                        // -> becomes per-user/per-school rows
    "lock": {                          // Setup lock: deters accidents, NOT security
      "enabled": true,
      "salt": "9f2c…",                 // the PIN itself is never stored
      "pinHash": "sha256 hex…"
    },
    "analyse": {                       // which charts this teacher wants
      "charts": { "gradeDistribution": true, "topicPerformance": true,
                  "questionAverages": true, "markDistribution": true },
      "gradeChartType": "bar",         // "bar" | "donut"
      "topicSort": "weakest"           // "weakest" | "strongest" | "name"
    }
  },

  "emailText": {                       // wording for EVERY pupil's email
    "pupil":  { "greeting": "Hi {firstName},", "extraMessage": "" },
    "parent": { "greeting": "Dear Parent / Guardian," }
  },

  "pupilEmailText": {                  // wording for ONE pupil, keyed by id.
    "p_1": { "pupil": { "greeting": "A quick word, {firstName}." } }
  },                                   // merged over emailText for that pupil

  "sendLog": [                         // -> send_log (audit trail)
    { "at": "...", "batchId": "...", "sent": 24, "failed": 0 }
  ]
}
```

Five deliberate decisions worth flagging:

- **`marks` is a nested object, not an array**, so a lookup is `marks[pupilId][questionId]`
  — O(1), and it survives questions or pupils being reordered or deleted.
- **`null` means "not marked"; `0` means "scored zero".** These are different facts
  about a child and the app never conflates them.
- **No percentage is stored or displayed anywhere.** GCSE-style assessment is read
  against grade boundaries, so the app reports marks and grades only. Proportions are
  still computed internally — for the >80% / <25% feedback rules and for the width of
  a bar — but they are never surfaced as a figure. The single exception is "marks
  entered", which measures progress through marking, not attainment.
- **A total and a grade exist only for a fully marked paper.** `pupilResult().total`
  and `.grade` are `null` until every question has a mark, the UI shows a dash, and
  such a pupil cannot be selected for feedback. Half a paper scored against a
  full-paper boundary would read as a fail, which would be worse than showing nothing.
- **`settings.lock` stores a salted SHA-256, never the PIN.** It is checked in the
  browser, so it stops a colleague editing the paper by accident during a marking
  session — it does not stop anyone determined. Real permissions need the server
  (§ Authentication).
- **IDs, not indexes, are used everywhere.** Delete question 3 and nothing else breaks.

---

## 10. Edge-case rules, stated once and implemented consistently

| Case | Rule |
|---|---|
| **Max marks of 0** | Rejected at setup. A question worth 0 marks makes `mark/max` a division by zero and can never be "80% correct". Minimum is 1. |
| **Blank mark** | Stored as `null`. Never silently treated as 0. Excluded from averages, from What Went Well and from Even Better If — you cannot conclude anything about a child from a question you haven't marked. |
| **`blankPolicy: "incomplete"`** (default) | Pupils with blanks are flagged, their grade is shown as *provisional*, and they are **deselected by default** on the Feedback page. |
| **`blankPolicy: "zero"`** | Only after the teacher explicitly ticks "treat blanks as zero", with a confirmation. Then blanks score 0 and count normally. |
| **What Went Well** | `mark / max > 0.80` — **strictly greater**. Exactly 80% (4/5) does **not** qualify. |
| **Even Better If** | `mark / max < 0.25` — **strictly less**. Exactly 25% (1/4) does **not** qualify. |
| **Both at once (same question)** | Impossible: 0.80 and 0.25 cannot both hold. No single question appears in both lists. |
| **Both at once (same topic)** | Possible and common — 5/5 on one algebra question, 0/5 on the next. Listing "Algebra" under both headings tells the pupil two contradictory things, so an overlapping topic is kept in **Even better if** and dropped from **What went well**. It is the actionable heading and the statement is still true. The question-by-question table always shows every mark exactly as entered. |
| **Duplicate topics** | Deduped **case-insensitively** and whitespace-trimmed (`"Algebra"` == `"algebra "`). The displayed spelling is the first one used anywhere in the question list, so the teacher's own capitalisation is preserved consistently across both headings. |
| **Duplicate reteach links** | Deduped by normalised URL, so one resource is never listed twice even if three questions point at it. |
| **Empty topic** | Skipped silently — never renders a blank bullet point. |
| **No email address** | Pupil is shown with a clear "No email address" badge, cannot be selected, and is never sent to. |
| **Parent email** | Always optional. A parent email is sent **only** if the address exists *and* the parent toggle is on. |
| **All questions blank** | Pupil has no data; feedback generation is blocked with an explanatory message rather than sending an empty email. |
| **Grade boundaries** | Must be strictly ascending and within `0..totalPossible`. U is locked at 0 so every mark always resolves to some grade. |
| **Mark > max** | Rejected at entry, inline, before it can enter the data. |
| **Negative mark** | Rejected. |

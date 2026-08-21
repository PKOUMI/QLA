# QLA — Question Level Analysis &amp; Feedback

Set up an assessment, enter marks question by question, and send every pupil
personalised feedback in a few minutes — instead of maintaining a fragile Excel
QLA spreadsheet and writing feedback by hand.

Built as a real, working application: no mock data, no fake "sending" animation.
Where something genuinely needs a server, there is a server.

---

## What it does

**Set up** — name the assessment; add questions with free-text numbers (`3a`,
`4(ii)`), max marks, topic/AO and a reteach link; pick Foundation or Higher and
enter your own grade boundaries; add pupils by hand or by CSV import with proper
validation.

**Marksheet** — a spreadsheet-style grid with questions across the top and
pupils down the side. Sticky headers, arrow-key navigation, per-cell validation,
live totals and grades, and a class-average row. Blank means *not marked*, never
*zero*, and a pupil's total and grade stay as a dash until every question on
their paper has been marked.

**Analyse** — the class picture: every question with its average, lowest and
highest mark, plus grade distribution, topic/AO performance, question averages
and a mark distribution with your boundaries drawn on. Each chart can be hidden
or shown as a table.

**Feedback** — pick who receives feedback, preview the exact email, then send.
Each email contains the results summary, a question-by-question table, and three
generated sections:

- **What went well** — topics where the pupil scored **more than 80%**
- **Even better if** — topics where the pupil scored **less than 25%**
- **Focus on** — the reteach links attached to those weak questions

Topics are de-duplicated case-insensitively; resources are de-duplicated by URL.

---

## Documentation

| File | What is in it |
|---|---|
| **[ARCHITECTURE.md](ARCHITECTURE.md)** | Why it is built this way, the email-provider comparison, the data model, security and GDPR reality, domains, and the roadmap to a paid SaaS |
| **[DEPLOYMENT.md](DEPLOYMENT.md)** | Step-by-step: GitHub Pages, Vercel, Resend, DNS records, custom domain, testing delivery |

---

## Running it locally

```bash
npm run dev     # http://localhost:5173
npm test        # 46 logic tests, no dependencies
```

A local web server is required — the app uses ES modules, which browsers will
not load from a `file://` path.

---

## How it is put together

```
Browser (GitHub Pages)                    Vercel function
┌───────────────────────┐                ┌────────────────────────┐
│ Setup → Marksheet →   │  structured    │ validate → render →    │
│ Feedback              │  JSON, HTTPS   │ rate limit → send      │
│                       │ ─────────────► │                        │
│ localStorage          │                │ RESEND_API_KEY (secret)│
└───────────────────────┘                └───────────┬────────────┘
                                                     ▼
                                                  Resend → inboxes
```

Two rules the code sticks to:

1. **No secret is ever in the front end.** GitHub Pages serves static files;
   anything it serves is public. The email API key lives only in the server's
   environment variables.
2. **The server renders the email, not the browser.** The browser sends data
   (`{pupilName, mark, outOf, topics}`), never HTML. That prevents the endpoint
   being used as an open mail relay to send arbitrary content from your domain.

### Files

| File | Responsibility |
|---|---|
| `js/model.js` | The shape of an assessment; pure helpers |
| `js/storage.js` | Persistence behind a swappable repository interface |
| `js/grades.js` | Totals, grade boundaries, averages, distributions |
| `js/validation.js` | Input checking, HTML escaping, CSV-injection defence |
| `js/csv.js` | CSV parsing, template, import validation, export |
| `js/feedback-engine.js` | What went well / Even better if / Focus on |
| `js/api.js` | Batching, retries, duplicate-send protection |
| `js/charts.js` | Dependency-free SVG charts for the Analyse page |
| `js/lock.js` | The Setup PIN lock (deters accidents, is not security) |
| `js/views/*.js` | One file per screen |
| `shared/email-template.js` | The email — imported by browser **and** server |
| `api/send-feedback.js` | The only thing that can send email |
| `api/_lib/mailer.js` | The only file that knows about Resend |

---

## Decisions worth knowing about

- **Blank is not zero.** A blank cell means "not marked yet". Those pupils are
  flagged, their grade is marked provisional, and they are excluded from
  feedback by default until you tick *Treat every blank cell as a score of 0*.
- **The thresholds are strict.** 4/5 is exactly 80% and does **not** count as a
  strength. 1/4 is exactly 25% and does **not** count as a weakness.
- **A topic never appears under both headings.** If a pupil is strong on one
  algebra question and weak on another, "Algebra" is listed under *Even better
  if* only — the actionable heading — rather than contradicting itself.
- **Nothing sends by accident.** Sending requires an explicit click plus a
  confirmation showing the exact count, and every request carries an idempotency
  key so a double-click cannot double-send.
- **Failures are reported honestly.** If the provider returns an error, the app
  says the email failed and shows why. It never reports a send that did not happen.

## What this is not, yet

No user accounts, no database, no payments. Data lives in one browser — export a
JSON backup regularly. The shared access key is a speed bump, not
authentication. **This is not GDPR-compliant software** and must not be described
as such; ARCHITECTURE.md §6 lists the twelve things needed before real schools
use it.

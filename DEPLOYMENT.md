# Deployment guide

Follow this top to bottom. Nothing here needs a paid account.

**Time needed:** about 25 minutes for steps 1–4 (a working app you can share a
link to). Steps 5–7 add real email and take another 20 minutes.

| Part | Where it goes | Cost |
|---|---|---|
| The app (HTML/CSS/JS) | GitHub Pages | Free |
| The email API | Vercel | Free (Hobby) |
| Email delivery | Resend | Free to 3,000/month |
| Domain (optional, later) | Any registrar | ~£10–15/year |

---

## Step 1 — Create the GitHub repository

### Repository structure

```
qla/
├── index.html                  the app
├── config.js                   <- the ONE file you edit after deploying
├── css/
│   └── styles.css
├── js/
│   ├── app.js                  shell: routing, saving, dialogs
│   ├── model.js                the shape of an assessment
│   ├── storage.js              localStorage today, a database later
│   ├── grades.js               totals, grade boundaries, averages
│   ├── validation.js           input checking and HTML escaping
│   ├── csv.js                  CSV import/export
│   ├── feedback-engine.js      what went well / even better if / focus on
│   ├── api.js                  talks to the backend
│   ├── ui.js                   small DOM helpers
│   ├── charts.js               SVG charts for the Analyse page
│   ├── lock.js                 the PIN lock itself
│   ├── lockbar.js              the lock bar and dialogs, shared by two pages
│   └── views/
│       ├── setup.js
│       ├── marksheet.js
│       ├── analyse.js
│       └── feedback.js
├── sample-data/                <- test data; safe to delete before going live
│   ├── gcse-science-paper-90-pupils.json
│   ├── gcse-class-list-90-pupils.csv
│   └── generate.mjs
├── shared/
│   └── email-template.js       used by BOTH the browser preview and the server
├── api/                        <- Vercel only; GitHub Pages ignores this
│   ├── send-feedback.js
│   ├── health.js
│   └── _lib/
│       ├── cors.js
│       ├── mailer.js           the only file that knows about Resend
│       ├── rate-limit.js
│       └── validate.js
├── tests/
│   └── run-tests.js
├── package.json
├── vercel.json
├── .env.example                a template — never contains real keys
├── .gitignore                  keeps .env out of git
├── ARCHITECTURE.md
├── DEPLOYMENT.md
└── README.md
```

### Creating it

1. Go to <https://github.com/new>.
2. **Repository name:** `qla` (or whatever you like).
3. **Public** or **Private** — note that GitHub Pages on a *private* repo needs a
   paid plan, so choose **Public** unless you are paying. Public is fine: the
   code contains no secrets and no pupil data.
4. Do **not** tick "Add a README" — you already have one.
5. Click **Create repository**.

### Uploading the files

**Option A — drag and drop (no tools needed).**

1. On the empty repository page, click **uploading an existing file**.
2. Drag the whole contents of the project folder into the box. GitHub keeps the
   folder structure, so drag the *contents*, not the folder itself.
3. Commit message: `Initial commit`. Click **Commit changes**.

One catch: GitHub's uploader silently skips empty folders. All of ours contain
files, so this is fine — but if a folder looks missing afterwards, that is why.

**Option B — git command line.**

```bash
cd path/to/qla
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOURNAME/qla.git
git push -u origin main
```

Before your first push, check `.gitignore` contains `.env`. If you ever commit a
real API key, **assume it is compromised**: revoke it at the provider and issue a
new one. Deleting the commit is not enough — it stays in the history and in
anyone's clone.

---

## Step 2 — Turn on GitHub Pages

1. In your repository, go to **Settings** → **Pages** (left sidebar).
2. Under **Build and deployment**:
   - **Source:** `Deploy from a branch`
   - **Branch:** `main`, folder `/ (root)`
3. Click **Save**.
4. Wait 1–2 minutes, then refresh. You will see:

   `Your site is live at https://YOURNAME.github.io/qla/`

Open it. The app works immediately — set up, marksheet, grades, preview — with
everything stored in your browser. Only sending email needs the rest of this guide.

**If you get a 404:** the file must be `index.html` in the repository root, in
lower case. Check the Actions tab for a failed "pages build and deployment" run.

**HTTPS.** GitHub issues and renews a free Let's Encrypt certificate for
`*.github.io` automatically. There is nothing to configure and nothing to renew.
This matters: browsers block `fetch()` from an `https://` page to an `http://`
API (mixed content), so both halves must be HTTPS. They will be.

---

## Step 3 — Set up Resend

You do not need a domain to start.

1. Sign up at <https://resend.com> (free, no card).
2. When asked to choose a region, pick **EU (Ireland)** — see ARCHITECTURE.md §6
   for why this matters for UK school data. This cannot be changed later.
3. Go to **API Keys** → **Create API Key**.
   - Name: `qla-production`
   - Permission: **Sending access** (not Full access — least privilege)
4. **Copy the key now.** It starts `re_` and is shown exactly once.
5. Paste it somewhere safe temporarily — a password manager, not a text file
   in your repository.

### Sending without a domain (for testing today)

Resend gives every account a shared sending address: `onboarding@resend.dev`.

Its important limitation: **it will only deliver to the email address you signed
up with.** That is deliberate, and it is enough to test the whole pipeline. Set
`FROM_EMAIL=onboarding@resend.dev` and send yourself a test with your own address
in the pupil list.

Do not attempt to run a real class through it — every email will silently fail to
deliver. Step 7 covers switching to your own domain.

---

## Step 4 — Deploy the backend to Vercel

1. Sign up at <https://vercel.com> with **Continue with GitHub**.
2. **Add New** → **Project** → find your `qla` repository → **Import**.
3. On the configure screen:
   - **Framework Preset:** `Other`
   - **Root Directory:** leave as `./`
   - Leave build and output settings empty — there is nothing to build.
4. Expand **Environment Variables** and add these:

| Name | Value |
|---|---|
| `RESEND_API_KEY` | the `re_...` key from step 3 |
| `FROM_EMAIL` | `onboarding@resend.dev` (for now) |
| `FROM_NAME` | `Assessment Feedback` |
| `ALLOWED_ORIGINS` | `https://YOURNAME.github.io` |
| `APP_SHARED_KEY` | a long random string — see below |
| `RATE_LIMIT_PER_MINUTE` | `40` |
| `MAX_EMAILS_PER_HOUR` | `5000` |

   Generate the shared key with one of these:

   ```bash
   openssl rand -base64 32                 # macOS / Linux
   ```
   ```powershell
   [Convert]::ToBase64String((1..32|%{Get-Random -Max 256}))   # Windows PowerShell
   ```

   `ALLOWED_ORIGINS` must be the **origin only** — scheme and host, no path and
   no trailing slash. `https://yourname.github.io/qla/` is wrong;
   `https://yourname.github.io` is right.

5. Click **Deploy**. It takes about a minute.
6. Copy your API address, e.g. `https://qla-abc123.vercel.app`.
7. Check it works — open `https://qla-abc123.vercel.app/api/health` in a browser.
   You should get JSON like this:

   ```jsonc
   {
     "ok": true,
     "emailConfigured": true,
     "fromAddress": "onboarding@resend.dev",
     "dryRun": false,
     "sharedKeyRequired": true
   }
   ```

   A browser typing the address directly sends no `Origin` header, so this is
   not a cross-site request and the allowlist does not apply — you see the real
   status. That makes this the quickest way to check the backend is alive and
   what it thinks it is configured with.

   `"emailConfigured": false` means `RESEND_API_KEY` did not reach this
   deployment. **Environment variables only apply to deployments created after
   they were saved** — adding one in the dashboard does nothing to what is
   already running. After any change:
   **Deployments → the most recent → ⋯ → Redeploy**.

### Where the API key actually lives

Vercel stores environment variables encrypted and injects them into the function
at runtime as `process.env.RESEND_API_KEY`. That process runs on Vercel's
servers. The browser never receives it, cannot request it, and it appears in no
file that GitHub Pages serves. This is the whole reason the backend exists.

---

## Step 5 — Connect the app to the backend

1. Open your GitHub Pages URL.
2. Click **Settings** (top right of the app).
3. **Email API address:** your Vercel URL, no trailing slash.
4. **Shared access key:** the same `APP_SHARED_KEY` value.
5. Click **Test connection**. You should see *Backend reachable*.
6. Click **Save**.

To set the API address for everyone instead of per-browser, edit `config.js` in
your repository and set `apiBaseUrl`. That file is public, so put the URL there —
never the shared key.

---

## Step 6 — Test email delivery safely

Do this before letting the tool near a real class.

1. Create an assessment with **two questions** (say 5 marks and 4 marks) and
   sensible boundaries.
2. Add **one pupil: yourself**, using the address you registered with Resend.
3. Enter marks that trigger every section: full marks on Q1 (What went well) and
   0 on Q2 (Even better if, and Focus on — give Q2 a reteach link).
4. Preview the email. Check both the pupil and parent tabs.
5. **Send feedback** and confirm.
6. Check your inbox, and your spam folder. Then open Resend's **Logs** page,
   which shows delivered, bounced and complained for every message.

### Rehearsing without sending anything

Add `DRY_RUN` = `true` to the Vercel environment variables and redeploy. The
whole flow runs, but no email leaves the building, and the app labels the result
**"Simulated only — no email was actually sent"** rather than claiming success.
Remove the variable when you are ready to send for real.

### Sending to a whole year group

The app sends 60 recipients per request, and the server passes each request to
Resend's batch endpoint, which takes up to 100 emails in a single API call. A
400-pupil year group with parents (800 emails) is about 14 requests and 16 calls
to Resend &mdash; comfortably inside every limit involved.

If a rate limit is hit anyway, the app **waits and continues**. It reads the
`Retry-After` the server sends, shows "pausing 12s, then continuing" on the
progress bar, and resumes. A rate limit is never reported as a failed email.

**Resend's free tier is capped at 100 emails a day**, regardless of any of the
above. One class is fine; a year group is not. That is the point at which the
$20/month tier (50,000 a month, no daily limit) becomes necessary.

### Warming up a new sending domain

A brand-new domain that sends 800 emails on its first day looks like a spam
blast, and a damaged reputation is far harder to repair than to avoid. Resend's
published schedule:

| Day | Emails that day | Per hour |
|---|---:|---:|
| 1 | 150 | &mdash; |
| 2 | 250 | &mdash; |
| 3 | 400 | &mdash; |
| 4 | 700 | 50 |
| 5 | 1,000 | 75 |
| 6 | 1,500 | 100 |
| 7 | 2,000 | 150 |

Set `MAX_EMAILS_PER_HOUR` to match the day you are on and raise it as you go.
The app then holds the line itself rather than depending on anyone remembering.

**Also ask the school's IT team to allowlist your sending domain** before any
trial involving more than one class. School mail is nearly always Microsoft 365
with Defender, which treats a few hundred external emails arriving at once
exactly as you would want it to treat spam. It is a routine request every edtech
supplier makes, it takes IT minutes, and skipping it means a working trial can
land silently in quarantine and look like a broken product.

### If email does not arrive

| Symptom | Cause | Fix |
|---|---|---|
| App says "Could not reach the email backend" | `ALLOWED_ORIGINS` wrong | Must match your Pages origin exactly, no trailing slash. Redeploy after changing. |
| `401 Invalid or missing access key` | Key mismatch | The app's Settings key must equal `APP_SHARED_KEY`. |
| `503 email provider is not configured` | `RESEND_API_KEY` missing | Add it in Vercel, then **redeploy** — env changes need a new deployment. |
| Resend log says "not allowed" | Using `onboarding@resend.dev` to a third party | Expected. Verify your own domain (step 7). |
| Nothing in the log at all | Request never arrived | Vercel → your project → Logs. |
| Delivered but in spam | No domain reputation yet | Step 7, including DMARC. |

---

## Step 7 — Your own domain (when you buy one)

You do not have a domain yet, so everything above uses the default addresses.
When you buy one, here is exactly what to change. Nothing in the code needs
rewriting — this is all DNS and settings.

### 7a. Buying

Any registrar works. UK-friendly options with sane DNS panels: Cloudflare
Registrar (at-cost, no markup), Namecheap, Gandi. `.co.uk` or `.com` both fine.

Avoid registrars that charge extra for DNS management or WHOIS privacy.

### 7b. The three hostnames

| Hostname | Serves | Points at |
|---|---|---|
| `yourdomain.co.uk` | Marketing site | Later — a static host |
| `app.yourdomain.co.uk` | The application | GitHub Pages |
| `api.yourdomain.co.uk` | The backend | Vercel |

This split is explained in ARCHITECTURE.md §7. You can add them one at a time;
`app.` and `api.` are the two that matter now.

### 7c. Point `app.` at GitHub Pages

At your registrar, add:

| Type | Name | Value | TTL |
|---|---|---|---|
| CNAME | `app` | `YOURNAME.github.io.` | 3600 |

Then in GitHub → **Settings** → **Pages** → **Custom domain**, enter
`app.yourdomain.co.uk` and save. GitHub adds a `CNAME` file to your repository —
leave it there. Wait for the DNS check to go green (minutes to a few hours),
then tick **Enforce HTTPS**.

> If you ever want the app on the **apex** (`yourdomain.co.uk` with no
> subdomain), a CNAME is not allowed there by the DNS specification. You would
> instead add four `A` records to `185.199.108.153`, `185.199.109.153`,
> `185.199.110.153` and `185.199.111.153`, plus the four matching `AAAA` records.
> Using `app.` avoids all of this, which is one more reason to use it.

### 7d. Point `api.` at Vercel

In Vercel → your project → **Settings** → **Domains** → add
`api.yourdomain.co.uk`. Vercel shows the exact record to create; it is normally:

| Type | Name | Value |
|---|---|---|
| CNAME | `api` | `cname.vercel-dns.com.` |

Then update `ALLOWED_ORIGINS` to include the new app address:

```
ALLOWED_ORIGINS=https://YOURNAME.github.io,https://app.yourdomain.co.uk
```

Redeploy, then update the API address in the app's Settings (and in `config.js`).

### 7e. Verify the domain for email

In Resend → **Domains** → **Add Domain** → `yourdomain.co.uk`. Resend gives you
records to add. They will look like this — **use the values Resend shows you,
not these**:

| Type | Name | Value | Purpose |
|---|---|---|---|
| MX | `send` | `feedback-smtp.eu-west-1.amazonses.com` (priority 10) | Return path for bounces |
| TXT | `send` | `v=spf1 include:amazonses.com ~all` | **SPF** — says which servers may send as you |
| TXT | `resend._domainkey` | `p=MIGfMA0GCSq...` (long) | **DKIM** — cryptographically signs each message |

Add them, then click **Verify**. Usually minutes; allow up to 48 hours.

Then add a DMARC record yourself — Resend does not create it and deliverability
to school mail systems is noticeably better with it:

| Type | Name | Value |
|---|---|---|
| TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:dmarc@yourdomain.co.uk;` |

`p=none` means "monitor, don't reject" — the right setting while you are
starting out. Once the reports show only your own mail passing, tighten it to
`p=quarantine` and later `p=reject`.

**What these three actually do:** SPF and DKIM let a receiving mail server check
that a message claiming to be from your domain really is. DMARC tells that server
what to do when the check fails, and sends you a report. Without them, school
filters — which are aggressive, because schools are phishing targets — will treat
bulk mail from a new domain as suspicious. With them, you look like a legitimate
sender.

Finally, in Vercel set:

```
FROM_EMAIL=feedback@yourdomain.co.uk
```

and redeploy. Send yourself another test.

### 7f. A note on subdomains for sending

Consider sending from a subdomain — `mail.yourdomain.co.uk` or
`feedback.yourdomain.co.uk` — rather than the apex. If a deliverability problem
ever damages that sender's reputation, your main domain's ordinary email is
unaffected. It costs nothing to do now and is awkward to change later.

---

## Step 8 — Everyday use

**Changing the app:** edit files in GitHub (or push). Pages redeploys in ~1
minute. Hard-refresh (`Ctrl`+`Shift`+`R`) to skip the browser cache.

**Changing the backend:** push to `main` and Vercel redeploys automatically.
Changing an environment variable does **not** redeploy — use
**Deployments → ⋯ → Redeploy**.

**Running it locally:**

```bash
npm run dev      # serves the app at http://localhost:5173
npm test         # runs the logic tests — 46 of them
```

You need a local server, not a double-clicked `index.html`: the app uses ES
modules, which browsers refuse to load from `file://`.

**Before each real send:** preview one email, check the class list on the
Feedback page, and confirm the count in the dialog matches what you expect.

---

## Checklist before a real class

- [ ] Own domain verified in Resend, with SPF, DKIM **and** DMARC
- [ ] `FROM_EMAIL` on your own domain
- [ ] `ALLOWED_ORIGINS` lists only your own sites
- [ ] `APP_SHARED_KEY` set and not the example value
- [ ] `DRY_RUN` **removed** from the environment
- [ ] Test email received in a real inbox, not spam
- [ ] Sent yourself a full-class dry run with your own address duplicated
- [ ] Told your school's data protection lead what you are doing — see
      ARCHITECTURE.md §6 for what they will ask, and what you cannot yet claim

# everypupil.com — the marketing site

One self-contained `index.html`. No build step, no framework, no external
requests: no web fonts, no analytics, no trackers, nothing loaded from another
domain. That is deliberate — a school DPO reading the page should find nothing
to query, and it stays fast on a school's contended wifi.

## Publishing it

The app lives on `app.everypupil.com`; this is the root domain. Keep them as
separate deployments so a change to one cannot break the other.

**Cloudflare Pages is the easy route**, since the domain is already on
Cloudflare:

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** →
   **Upload assets**
2. Drag in this folder, name the project `everypupil-site`, deploy
3. **Custom domains** → add `everypupil.com` and `www.everypupil.com`
4. Cloudflare adds the DNS records itself, because it already runs the zone

Free, and updating it is another drag-and-drop. Connect it to a Git repo
instead if you would rather it deploy on push.

## Before it goes live

Things on the page that are promises, not code. Each needs to be true, or
softened, before you publish:

| Claim | What has to exist |
|---|---|
| "Held in the UK" | The Supabase London project, once accounts ship |
| "Data processing agreement" | An actual DPA to send a school |
| "Deleted within 30 days" | A deletion process you follow |
| "No trackers" | True today — keep it that way if you add analytics |
| Prices | Yours to set. Every figure is a starting point |
| `hello@everypupil.com` | A mailbox that exists and gets read |
| `/privacy/` and `/terms/` | Two pages that do not exist yet |

The data-protection section already says plainly that cloud storage is still
being built. Update that line when it ships — being caught overstating it to a
DPO would cost more than the feature is worth.

## What is deliberately not here

No customer logos, quotes or "trusted by N schools". Inventing those is both
dishonest and the fastest way to lose a trust's confidence. Add them when you
have real ones, with permission.

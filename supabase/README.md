# Database setup — one school

Three SQL files and about forty minutes, most of it waiting for DNS. You need
the Supabase project created first (London region, `eu-west-2` — it cannot be
changed afterwards, only migrated).

Run the files in order. Each one is safe to run again.

| File | What it does |
|---|---|
| `migrations/0001_schema.sql` | The eight tables and the security policies |
| `migrations/0002_access.sql` | Who is allowed to sign in, and how they get linked to your school |
| `seed/first-school.sql` | Creates your school and makes you the owner. Edit two lines first |
| `tests/security.sql` | Proves the above. Seven rows, all PASS |

## 1. Create the tables

Supabase dashboard → **SQL Editor** in the left sidebar → **New query** →
paste the whole of `migrations/0001_schema.sql` → **Run** (or Ctrl+Enter).

That is the only SQL editor you need. It runs against your live database, so
there is nothing to install and no connection string to configure.

It should finish with no errors. It creates eight tables, the security
policies, and two triggers.

## 2. Check it is actually locked down

Three ways, in increasing order of how much they prove.

### Supabase's own Security Advisor

Dashboard → **Database** → **Security Advisor**. Supabase runs its own checks
there, including `rls_disabled_in_public` (a public table with security off) and
`rls_enabled_no_policy` (security on but nothing allowed through, so the app
breaks). Worth a glance after any schema change — it catches things nobody
thinks to look for.

### The Table Editor

Dashboard → **Table Editor**. Each table shows whether RLS is on. All eight
should say enabled.

### The checks in this repo

Same SQL Editor, New query, paste `tests/security.sql`, Run. It returns **seven rows, and every one must say PASS.** (It is written as a single query on purpose: the SQL Editor only shows the result of the last statement in a script, so seven separate statements would show one row and hide the other six.)

Rows 6 and 7 say `SKIP` until you have run `0002_access.sql`.

If any says FAIL, stop and tell me before putting real pupil data in. These
checks exist because the likeliest route to a real breach is a table added
later with security left switched off — it fails silently and looks fine.

Re-run this file after any schema change. It takes five seconds.

## 3. Decide who is allowed in

Run `migrations/0002_access.sql` the same way.

This is the part that makes the tool usable by a whole staff. A teacher goes to
the app, types their school email, and gets a six-digit code — no account for
you to create, no password for them to forget. What stops it being open to the
world is a **staff list**: an address that is not on it is refused before an
account is ever created.

Note the shape of that. Restricting by email *domain* would be wrong for most
schools, because pupils are on the same domain as staff — and a pupil who could
sign in would see the whole year group's marks. So it is a list of individual
addresses, added deliberately.

### Switch the hook on

Creating the function is not enough. Dashboard → **Authentication** → **Hooks**
→ **Before User Created** → choose `hook_restrict_signup` → enable.

If you skip this, nothing leaks: an account with no membership row can read
nothing at all, and the app tells that person to ask their school to add them.
What you lose is the front door. Strangers could create empty accounts and burn
through your email allowance requesting codes. Switch it on.

## 4. Create your school and add your staff

Open `seed/first-school.sql`, change the two lines marked `EDIT ME` to your
school's name and your own work email address, and run it. That makes you the
owner.

The rest of the file has a block for adding colleagues — one row each, pasted
from your staff list. Case and spare spaces do not matter; addresses are
normalised on the way in. Roles:

| Role | Can |
|---|---|
| `teacher` | Set up assessments, enter marks, send feedback |
| `admin` | All of that, plus adding and removing staff |
| `owner` | The same as admin. Kept separate so there is always one |

To see who has actually signed in:

```sql
select email, role, accepted_at from staff_invites
order by accepted_at nulls first, email;
```

`accepted_at` is null until they first sign in.

## 5. Make Supabase able to send the codes

**Do this before you tell anyone the app is ready.** Out of the box Supabase
sends **two emails an hour**, total, across the whole project. That is a
testing allowance, not a service. The third teacher to arrive on Monday morning
gets nothing, and it will look like your fault.

### Make the email contain a code rather than a link

Dashboard → **Authentication** → **Emails** → **Magic Link** template. By
default it sends a link. The app asks for a code, so the template must include
the code:

```html
<p>Your EveryPupil sign-in code is:</p>
<p style="font-size:28px;letter-spacing:6px;font-weight:700">{{ .Token }}</p>
<p>It is valid for one hour. If you did not ask for it, ignore this email.</p>
```

Without `{{ .Token }}`, the email arrives with nothing to type in.

**Paste it into two templates, not one.** A teacher signing in for the first
time is a new account, so GoTrue sends **Confirm signup**; everybody after that
gets **Magic Link**. Edit only one and either the first sign-in or every
subsequent one arrives as a link nobody asked for.

The code may be six digits or eight — GoTrue's OTP length is a server setting
and which value a project is created with has varied. The app takes anything
from six to ten and lets the server decide whether it is right, so you do not
have to match a number anywhere. Longer is stronger: if yours sends eight,
leave it.

### Point Supabase at Resend

Dashboard → **Project Settings** → **Authentication** → **SMTP Settings**.
Use the Resend SMTP details for the domain you have already verified
(`everypupil.com`), with a sender like `no-reply@everypupil.com`.

Then Dashboard → **Authentication** → **Rate Limits**: custom SMTP starts at
**30 emails an hour**, which is still low for a whole school signing in on the
same INSET morning. Raise it.

Sign-in codes and pupil feedback are different jobs. If you later want them
kept apart — so a feedback send that upsets a spam filter cannot stop staff
signing in — use a separate subdomain for authentication mail. Not urgent for
one school; worth knowing before it is fifty.

## Why you do not have to switch RLS on yourself

`0001_schema.sql` does it, with an explicit
`alter table ... enable row level security` for all eight tables, and every
policy is scoped `to authenticated` so a signed-out visitor is excluded by
name rather than by side effect.

That last part matters more than it looks. Supabase grants table privileges to
the `anon` role on every new public table by design — so "anon has no
privileges" is the wrong thing to check, and a checker that flags it would be
crying wolf on a perfectly safe project. What actually keeps anon out is that
no policy admits it. Verified here against PostgreSQL 16 with those default
grants in place: a signed-out request reads **0 rows**, while the teacher reads
their own.

## What the security policies actually do

The application never writes `where org_id = ...` into a query. Postgres adds
it underneath, so a bug in the app returns nothing rather than another
school's data.

Verified against PostgreSQL 16 before shipping, with two schools in one
database:

| Attempt | Result |
|---|---|
| `select * from pupils` as a teacher | Only their own school's pupils |
| Same query, signed out | Nothing at all |
| Insert a pupil into another school | Rejected by the database |
| Update another school's pupil | Zero rows changed |
| `delete from marks` with no `where` | Deleted only their own school's |
| Remove a pupil from an assessment | Only that assessment's marks went; the pupil and their other papers survived |
| Same pupil email twice in one school | Rejected |
| Same email at a different school | Allowed |

And `0002_access.sql`, checked the same way:

| Attempt | Result |
|---|---|
| Address pasted as `  Alice@Northgate.sch.uk ` | Stored as `alice@northgate.sch.uk` |
| Signup hook, invited address | Allowed |
| Signup hook, stranger | Refused, 403 |
| Invited teacher signs in for the first time | Membership created automatically |
| Somebody invited *after* their account existed | `claim_membership()` links them on next sign-in |
| A stranger who somehow has an account reads pupils | 0 rows |
| The same stranger reads the staff list | 0 rows |
| A teacher tries to add a colleague | Rejected — admins only |
| An owner adds a colleague | Allowed |
| An owner adds somebody to a *different* school | Rejected |
| Signed out, reading the staff list | No privilege at all |
| A signed-in user calling the signup hook directly | Not permitted |

## A note on the free plan

Supabase say they "may pause applications on the Free Plan that exhibit low
activity in a 7-day period". A half-term break is exactly that, and teachers
coming back to a paused project is a bad first impression that costs more than
the subscription. Move to Pro (about £20/month) before colleagues start
depending on it.

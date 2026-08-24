# Database setup — one school

Two SQL files and about twenty minutes. You need the Supabase project created
first (London region, `eu-west-2` — it cannot be changed afterwards).

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

Same SQL Editor, paste `tests/security.sql`, Run. **Every line must say PASS.**

If any says FAIL, stop and tell me before putting real pupil data in. These
checks exist because the likeliest route to a real breach is a table added
later with security left switched off — it fails silently and looks fine.

Re-run this file after any schema change. It takes five seconds.

## 3. Create your school and make yourself the owner

Sign in to the app once first, so Supabase creates your user record. Then:

```sql
-- Your school. Change the name.
insert into organisations (name, kind)
values ('Your School Name', 'school')
returning id;

-- Make yourself the owner. Use your own email.
insert into memberships (user_id, org_id, role)
select u.id, o.id, 'owner'
from auth.users u, organisations o
where u.email = 'you@yourschool.sch.uk'
  and o.name  = 'Your School Name';
```

## 4. Add each teacher in the pilot

Authentication → **Users** → **Add user** → their school email. Then:

```sql
insert into memberships (user_id, org_id, role)
select u.id, o.id, 'teacher'
from auth.users u, organisations o
where u.email in (
        'a.teacher@yourschool.sch.uk',
        'b.teacher@yourschool.sch.uk'
      )
  and o.name = 'Your School Name';
```

Only people in `memberships` can see anything. A Supabase account with no
membership row signs in successfully and finds an empty application, which is
the behaviour you want — not an error, and not somebody else's pupils.

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

## A note on the free plan

Supabase say they "may pause applications on the Free Plan that exhibit low
activity in a 7-day period". A half-term break is exactly that, and teachers
coming back to a paused project is a bad first impression that costs more than
the subscription. Move to Pro (about £20/month) before colleagues start
depending on it.

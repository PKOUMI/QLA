-- ===========================================================================
-- Security checks. Run against your Supabase project after any schema change:
-- SQL Editor -> New query -> paste -> Run. Every row should say PASS.
--
-- This is deliberately ONE query with UNION ALL rather than five separate
-- statements. The Supabase SQL Editor only displays the result of the last
-- statement in a script, so five statements would show one row and quietly
-- hide the four that matter most.
--
-- These are not decoration. The single most likely route to a real breach is
-- a table added later with Row Level Security left switched off, which fails
-- silently and looks completely fine.
-- ===========================================================================

-- 1. Every table in public has RLS enabled.
select 1 as check_no, case when count(*) = 0
    then 'PASS  every table has row level security enabled'
    else 'FAIL  RLS is OFF for: ' || string_agg(relname, ', ')
  end as result
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity

union all

-- 2. Every table with RLS on actually has at least one policy. RLS with no
--    policy denies everything, which is safe but means the app is broken.
select 2, case when count(*) = 0
    then 'PASS  every protected table has at least one policy'
    else 'FAIL  no policy on: ' || string_agg(relname, ', ')
  end
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
  and not exists (select 1 from pg_policies p where p.tablename = c.relname)

union all

-- 3. No policy lets a signed-out visitor through.
--    NOT a check that anon lacks table grants: Supabase grants privileges to
--    anon on every new public table by design, and RLS is what actually decides
--    the rows. Checking the grants would fail here on a perfectly safe project,
--    and a check that cries wolf is one you learn to ignore.
select 3, case when count(*) = 0
    then 'PASS  every policy is scoped to signed-in users only'
    else 'FAIL  these policies also apply to anon: ' || string_agg(policyname, ', ')
  end
from pg_policies
where schemaname = 'public' and ('anon' = any(roles) or 'public' = any(roles))

union all

-- 4. A mark can be NULL. If this ever becomes NOT NULL, "not marked yet"
--    collapses into "scored zero" and the app starts lying to children.
select 4, case when bool_or(is_nullable = 'YES')
    then 'PASS  marks.mark is nullable, so blank stays distinct from zero'
    else 'FAIL  marks.mark is NOT NULL — blank would become zero'
  end
from information_schema.columns
where table_schema = 'public' and table_name = 'marks' and column_name = 'mark'

union all

-- 5. Pupil identity is enforced by the database, not by hopeful application
--    code, so one child cannot become four records on repeated imports.
select 5, case when count(*) >= 2
    then 'PASS  pupil email and external id are unique within a school'
    else 'FAIL  pupil identity indexes are missing'
  end
from pg_indexes
where schemaname = 'public' and tablename = 'pupils' and indexname in ('pupils_org_email','pupils_org_extid')

union all

-- 6. The signup hook can only be run by the authentication service. If a
--    signed-in user could call it they could not change who gets in, but they
--    could read your whole staff list one address at a time by guessing.
select 6, case
    when not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                     where n.nspname = 'public' and p.proname = 'hook_restrict_signup')
      then 'SKIP  0002_access.sql has not been run yet'
    when has_function_privilege('anon', 'public.hook_restrict_signup(jsonb)', 'execute')
      or has_function_privilege('authenticated', 'public.hook_restrict_signup(jsonb)', 'execute')
      then 'FAIL  the signup hook is callable by ordinary users'
    else 'PASS  the signup hook can only be run by the authentication service'
  end

union all

-- 7. The staff list is not readable by a signed-out visitor. Names and work
--    email addresses of every member of staff is exactly the list a phisher
--    would like to start from.
select 7, case
    when to_regclass('public.staff_invites') is null
      then 'SKIP  0002_access.sql has not been run yet'
    when has_table_privilege('anon', 'public.staff_invites', 'select')
      then 'FAIL  signed-out visitors have read privilege on the staff list'
    else 'PASS  the staff list is closed to signed-out visitors'
  end

order by 1;

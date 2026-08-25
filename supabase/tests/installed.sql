-- ===========================================================================
-- What is actually installed?
--
-- Run this in the Supabase SQL Editor when something in the app says a table
-- or a function is missing. It reports which migration files have been run
-- against this project and which have not, and it reloads PostgREST's schema
-- cache at the end.
--
-- THE SCHEMA CACHE, because it is the confusing one:
-- PostgREST — the thing the app actually talks to — keeps its own list of the
-- tables and functions available. It normally notices a change within seconds.
-- If it has not, a function that plainly exists will still be reported as
-- "not found in the schema cache". The last line here tells it to look again.
-- ===========================================================================

select 1 as step, case when to_regclass('public.assessments') is null
    then 'MISSING  0001_schema.sql has not been run'
    else 'OK       0001_schema.sql — tables and security policies'
  end as result

union all

select 2, case when to_regclass('public.staff_invites') is null
    then 'MISSING  0002_access.sql has not been run — nobody new can sign in'
    else 'OK       0002_access.sql — the staff list and the signup hook'
  end

union all

select 3, case when to_regclass('public.assessment_teachers') is null
    then 'MISSING  0003_roles.sql has not been run — everybody can do everything'
    else 'OK       0003_roles.sql — what each role may do'
  end

union all

select 4, case when not exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'invite_staff')
    then 'MISSING  0004_staff.sql has not been run — the Staff screen cannot add anybody'
    else 'OK       0004_staff.sql — managing staff from inside the app'
  end

union all

-- The hook is created by 0004 but must also be switched on by hand at
-- Authentication -> Hooks. Nothing in SQL can see whether that was done, so
-- this only reports that the function is there to be chosen.
select 5, case when not exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'hook_restrict_signup')
    then 'MISSING  the signup hook function'
    else 'OK       the signup hook exists (check it is ENABLED under Authentication -> Hooks)'
  end

union all

select 6, case when not exists (select 1 from organisations)
    then 'MISSING  no school yet — run seed/first-school.sql'
    else 'OK       school: ' || (select string_agg(name, ', ') from organisations)
  end

union all

select 7, case when not exists (select 1 from staff_invites where role = 'owner')
    then 'MISSING  no owner — run seed/first-school.sql'
    else 'OK       ' || (select count(*) from staff_invites) || ' on the staff list, '
       || (select count(*) from memberships) || ' signed in at least once'
  end

order by 1;

-- Tell PostgREST to re-read the schema. Harmless to run at any time, and the
-- fix when the app says a function it can see with its own eyes is missing.
notify pgrst, 'reload schema';

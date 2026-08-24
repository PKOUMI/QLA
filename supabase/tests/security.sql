-- ===========================================================================
-- Security checks. Run against your Supabase project after any schema change:
-- SQL Editor -> paste -> Run. Every line should say PASS.
--
-- These are not decoration. The single most likely route to a real breach is
-- a table added later with Row Level Security left switched off, which fails
-- silently and looks completely fine.
-- ===========================================================================

-- 1. Every table in public has RLS enabled.
select
  case when count(*) = 0
    then 'PASS  every table has row level security enabled'
    else 'FAIL  RLS is OFF for: ' || string_agg(relname, ', ')
  end as check_rls_enabled
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind = 'r'
  and not c.relrowsecurity;

-- 2. Every table with RLS on actually has at least one policy. RLS with no
--    policy denies everything, which is safe but means the app is broken.
select
  case when count(*) = 0
    then 'PASS  every protected table has at least one policy'
    else 'FAIL  no policy on: ' || string_agg(relname, ', ')
  end as check_policies_exist
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind = 'r'
  and c.relrowsecurity
  and not exists (select 1 from pg_policies p where p.tablename = c.relname);

-- 3. Nothing in public is readable by an anonymous visitor.
select
  case when count(*) = 0
    then 'PASS  the anon role has no table privileges in public'
    else 'FAIL  anon can reach: ' || string_agg(distinct table_name, ', ')
  end as check_anon_locked_out
from information_schema.role_table_grants
where grantee = 'anon' and table_schema = 'public';

-- 4. A mark can be NULL. If this ever becomes NOT NULL, "not marked yet"
--    collapses into "scored zero" and the app starts lying to children.
select
  case when is_nullable = 'YES'
    then 'PASS  marks.mark is nullable, so blank stays distinct from zero'
    else 'FAIL  marks.mark is NOT NULL — blank would become zero'
  end as check_blank_is_not_zero
from information_schema.columns
where table_name = 'marks' and column_name = 'mark';

-- 5. Pupil identity is enforced by the database, not by hopeful application
--    code, so one child cannot become four records on repeated imports.
select
  case when count(*) >= 2
    then 'PASS  pupil email and external id are unique within a school'
    else 'FAIL  pupil identity indexes are missing'
  end as check_pupil_identity
from pg_indexes
where tablename = 'pupils' and indexname in ('pupils_org_email','pupils_org_extid');

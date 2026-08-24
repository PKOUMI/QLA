-- ===========================================================================
-- EveryPupil — what each role may actually do
--
-- Run after 0002_access.sql. Safe to run more than once.
--
--   teacher  enters marks, on the assessments they have been assigned to,
--            and can read the whole school's assessments and analysis
--   admin    all of the above, plus creating assessments, editing the paper,
--            managing pupils, sending feedback, and managing staff
--   owner    the same as admin, kept separate so a school always has one
--
-- The split follows the two acts with consequences: deciding what the paper
-- says, and putting an email in front of a parent. Typing a 4 into a box is
-- not one of those, so it is not restricted beyond who is marking what.
--
-- WHY THIS IS IN SQL AND NOT IN THE APP
-- Hiding a button is a courtesy to the person using the screen. It is not a
-- permission. Everything below is enforced by Postgres, so a teacher who
-- opened the browser console and called the API by hand would get exactly the
-- same answer as a teacher using the buttons.
-- ===========================================================================

-- --------------------------------------------------------------------------
-- Who is marking which paper
-- --------------------------------------------------------------------------

create table if not exists assessment_teachers (
  assessment_id uuid not null references assessments(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  added_by      uuid references auth.users(id),
  created_at    timestamptz not null default now(),
  primary key (assessment_id, user_id)
);

create index if not exists assessment_teachers_user on assessment_teachers (user_id);

grant select, insert, update, delete on assessment_teachers to authenticated;
revoke all on assessment_teachers from anon;

-- --------------------------------------------------------------------------
-- Helpers
--
-- All SECURITY DEFINER and STABLE: they are called once per statement rather
-- than once per row, and they can see the membership rows the caller cannot.
-- --------------------------------------------------------------------------

create or replace function app_assessment_org(target uuid)
returns uuid
language sql stable security definer set search_path = public
as $$
  select org_id from assessments where id = target
$$;

-- May the caller change the marks on this paper?
create or replace function app_can_mark(target uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
           select 1 from assessment_teachers
           where assessment_id = target and user_id = auth.uid())
      or app_is_admin(app_assessment_org(target))
$$;

-- May the caller change the paper itself — questions, pupils, boundaries?
create or replace function app_can_manage(target uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select app_is_admin(app_assessment_org(target))
$$;

-- The colleagues in your school, for the "who is marking this?" screen.
-- SECURITY DEFINER because listing them means reading auth.users, which no
-- ordinary role can do. Scoped to your own school by app_org_ids().
create or replace function school_staff()
returns table (user_id uuid, email text, member_role text)
language sql stable security definer set search_path = public
as $$
  select m.user_id, u.email, m.role
  from memberships m
  join auth.users u on u.id = m.user_id
  where m.org_id in (select app_org_ids())
  order by u.email
$$;

grant execute on function school_staff() to authenticated;
revoke execute on function school_staff() from anon, public;

-- --------------------------------------------------------------------------
-- Policies
--
-- Two per table. A READ policy that any member of the school passes, and a
-- WRITE policy that only the right role passes. Postgres ORs permissive
-- policies together, so the read policy alone never grants a write.
-- --------------------------------------------------------------------------

-- Pupils are part of setting up: admins maintain the roster.
drop policy if exists pupils_all    on pupils;
drop policy if exists pupils_read   on pupils;
drop policy if exists pupils_manage on pupils;
create policy pupils_read on pupils for select to authenticated
  using (org_id in (select app_org_ids()));
create policy pupils_manage on pupils for all to authenticated
  using (app_is_admin(org_id)) with check (app_is_admin(org_id));

-- Assessments: everyone in the school can see them and their analysis.
drop policy if exists assess_all    on assessments;
drop policy if exists assess_read   on assessments;
drop policy if exists assess_manage on assessments;
create policy assess_read on assessments for select to authenticated
  using (org_id in (select app_org_ids()));
create policy assess_manage on assessments for all to authenticated
  using (app_is_admin(org_id)) with check (app_is_admin(org_id));

-- The questions are the paper. Changing one after marking has begun changes
-- what every pupil is told about their work, so it is an admin's decision.
drop policy if exists questions_all    on questions;
drop policy if exists questions_read   on questions;
drop policy if exists questions_manage on questions;
create policy questions_read on questions for select to authenticated
  using (assessment_id in (select id from assessments));
create policy questions_manage on questions for all to authenticated
  using (app_can_manage(assessment_id)) with check (app_can_manage(assessment_id));

-- Who sat the paper: also setup.
drop policy if exists entries_all    on assessment_pupils;
drop policy if exists entries_read   on assessment_pupils;
drop policy if exists entries_manage on assessment_pupils;
create policy entries_read on assessment_pupils for select to authenticated
  using (assessment_id in (select id from assessments));
create policy entries_manage on assessment_pupils for all to authenticated
  using (app_can_manage(assessment_id)) with check (app_can_manage(assessment_id));

-- Marks: the one thing a teacher writes, and only on their own papers.
drop policy if exists marks_all  on marks;
drop policy if exists marks_read on marks;
drop policy if exists marks_edit on marks;
create policy marks_read on marks for select to authenticated
  using (assessment_id in (select id from assessments));
create policy marks_edit on marks for all to authenticated
  using (app_can_mark(assessment_id)) with check (app_can_mark(assessment_id));

-- Sending is the act that reaches a parent. Admins only, and the log of what
-- was sent is written by the database's rules, not by the app's good manners.
drop policy if exists sendlog_all  on send_log;
drop policy if exists sendlog_read on send_log;
drop policy if exists sendlog_write on send_log;
create policy sendlog_read on send_log for select to authenticated
  using (assessment_id in (select id from assessments));
create policy sendlog_write on send_log for all to authenticated
  using (app_can_manage(assessment_id)) with check (app_can_manage(assessment_id));

-- Who is marking what: visible to the school, decided by admins.
alter table assessment_teachers enable row level security;

drop policy if exists marking_read   on assessment_teachers;
drop policy if exists marking_manage on assessment_teachers;
create policy marking_read on assessment_teachers for select to authenticated
  using (assessment_id in (select id from assessments));
create policy marking_manage on assessment_teachers for all to authenticated
  using (app_can_manage(assessment_id)) with check (app_can_manage(assessment_id));

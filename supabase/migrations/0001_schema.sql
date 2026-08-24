-- ===========================================================================
-- EveryPupil — schema, one school edition
--
-- Run this once in Supabase: SQL Editor -> New query -> paste -> Run.
--
-- Everything carries org_id even though there is exactly one organisation to
-- begin with. That single decision is what makes going multi-school later an
-- insert rather than a migration of live pupil data.
-- ===========================================================================

-- --------------------------------------------------------------------------
-- Organisations and who belongs to them
-- --------------------------------------------------------------------------

create table if not exists organisations (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  kind       text not null default 'school'
             check (kind in ('school','trust','individual')),
  trust_id   uuid references organisations(id),
  plan       text not null default 'school',
  created_at timestamptz not null default now()
);

create table if not exists memberships (
  user_id    uuid not null references auth.users(id) on delete cascade,
  org_id     uuid not null references organisations(id) on delete cascade,
  role       text not null default 'teacher'
             check (role in ('owner','admin','teacher')),
  created_at timestamptz not null default now(),
  primary key (user_id, org_id)
);

create index if not exists memberships_user on memberships (user_id);

-- --------------------------------------------------------------------------
-- Pupils belong to the school. Not to a class, not to an assessment: teaching
-- sets change through the year and tiers cut across them, but the pupil is
-- still the same pupil.
-- --------------------------------------------------------------------------

create table if not exists pupils (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organisations(id) on delete cascade,
  name         text not null,
  email        text,
  parent_email text,
  external_id  text,                       -- optional MIS / UPN reference
  group_label  text,                       -- "10B/Sc2" — a label, not a structure
  email_text   jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Identity on re-import. Either key alone is enough to recognise somebody;
-- names are never used for matching, because two J Smiths in a year group is
-- normal and merging two children would be unforgivable.
create unique index if not exists pupils_org_email
  on pupils (org_id, lower(email)) where email is not null;
create unique index if not exists pupils_org_extid
  on pupils (org_id, external_id) where external_id is not null;
create index if not exists pupils_org on pupils (org_id);

-- --------------------------------------------------------------------------
-- Assessments
-- --------------------------------------------------------------------------

create table if not exists assessments (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references organisations(id) on delete cascade,
  owner_id         uuid not null references auth.users(id),
  name             text not null,
  subject          text,
  exam_date        date,
  paper_type       text not null default 'higher'
                   check (paper_type in ('foundation','higher')),
  blank_policy     text not null default 'incomplete'
                   check (blank_policy in ('incomplete','zero')),
  grade_boundaries jsonb not null default '[]'::jsonb,
  email_text       jsonb not null default '{}'::jsonb,
  settings         jsonb not null default '{}'::jsonb,
  lock_pin_hash    text,
  lock_salt        text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists assessments_org on assessments (org_id);

create table if not exists questions (
  id            uuid primary key default gen_random_uuid(),
  assessment_id uuid not null references assessments(id) on delete cascade,
  position      int  not null,
  number        text not null,             -- "01.1" — free text on purpose
  max_marks     numeric not null check (max_marks > 0),
  topic         text,
  reteach_url   text
);

create index if not exists questions_assessment on questions (assessment_id, position);

-- Who actually sat this paper. An assessment is a script, not a class: the
-- Foundation entry and the Higher entry draw different pupils from one group.
create table if not exists assessment_pupils (
  assessment_id uuid not null references assessments(id) on delete cascade,
  pupil_id      uuid not null references pupils(id) on delete cascade,
  position      int  not null,
  primary key (assessment_id, pupil_id)
);

create index if not exists assessment_pupils_pupil on assessment_pupils (pupil_id);

-- NULL mark means NOT MARKED. It is not zero and never silently becomes zero.
-- The whole application depends on that distinction holding.
--
-- A mark hangs off the ENTRY, so removing somebody from an assessment takes
-- their marks for it with them and leaves every other paper they sat alone.
create table if not exists marks (
  assessment_id uuid not null,
  pupil_id      uuid not null,
  question_id   uuid not null references questions(id) on delete cascade,
  mark          numeric,
  updated_at    timestamptz not null default now(),
  primary key (assessment_id, pupil_id, question_id),
  foreign key (assessment_id, pupil_id)
    references assessment_pupils(assessment_id, pupil_id) on delete cascade
);

-- An audit trail. Schools will ask what was sent, to whom, and by whom.
create table if not exists send_log (
  id            uuid primary key default gen_random_uuid(),
  assessment_id uuid not null references assessments(id) on delete cascade,
  sent_by       uuid references auth.users(id),
  sent_at       timestamptz not null default now(),
  recipients    int not null default 0,
  succeeded     int not null default 0,
  failed        int not null default 0
);

create index if not exists send_log_assessment on send_log (assessment_id, sent_at desc);

-- --------------------------------------------------------------------------
-- Row Level Security
--
-- The application never adds "where org_id = ..." to a query. Postgres does it,
-- underneath, where forgetting is not possible. A bug in the app becomes an
-- empty result rather than another school's pupil data.
-- --------------------------------------------------------------------------

-- Which organisations the caller belongs to. STABLE so the planner can cache
-- it per statement rather than re-running it for every row.
create or replace function app_org_ids()
returns setof uuid
language sql stable security definer set search_path = public
as $$
  select org_id from memberships where user_id = auth.uid()
$$;

alter table organisations      enable row level security;
alter table memberships        enable row level security;
alter table pupils             enable row level security;
alter table assessments        enable row level security;
alter table questions          enable row level security;
alter table assessment_pupils  enable row level security;
alter table marks              enable row level security;
alter table send_log           enable row level security;

-- Every policy is scoped `to authenticated`. Supabase grants table privileges
-- to anon by default, so saying who a policy is for makes the intent explicit
-- rather than leaving anon's exclusion to rest on auth.uid() being null.
-- Tables that carry org_id directly.
create policy org_read   on organisations for select to authenticated using (id in (select app_org_ids()));
create policy mem_read   on memberships   for select to authenticated using (user_id = auth.uid());

create policy pupils_all on pupils      for all to authenticated
  using (org_id in (select app_org_ids()))
  with check (org_id in (select app_org_ids()));

create policy assess_all on assessments for all to authenticated
  using (org_id in (select app_org_ids()))
  with check (org_id in (select app_org_ids()));

-- Children reach org_id through their parent assessment.
create policy questions_all on questions for all to authenticated
  using (assessment_id in (select id from assessments))
  with check (assessment_id in (select id from assessments));

create policy entries_all on assessment_pupils for all to authenticated
  using (assessment_id in (select id from assessments))
  with check (assessment_id in (select id from assessments));

create policy marks_all on marks for all to authenticated
  using (assessment_id in (select id from assessments))
  with check (assessment_id in (select id from assessments));

create policy sendlog_all on send_log for all to authenticated
  using (assessment_id in (select id from assessments))
  with check (assessment_id in (select id from assessments));

-- --------------------------------------------------------------------------
-- Keep updated_at honest without the application having to remember.
-- --------------------------------------------------------------------------

create or replace function touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

create trigger assessments_touch before update on assessments
  for each row execute function touch_updated_at();
create trigger pupils_touch before update on pupils
  for each row execute function touch_updated_at();
create trigger marks_touch before update on marks
  for each row execute function touch_updated_at();

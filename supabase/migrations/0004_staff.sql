-- ===========================================================================
-- EveryPupil — managing staff from inside the app
--
-- Run after 0003_roles.sql. Safe to run more than once.
--
-- Until now, adding a colleague meant an admin opening the SQL editor. That is
-- fine for one person setting things up and hopeless for a school.
--
-- Everything here goes through a function rather than through a policy on the
-- table. Policies answer "may this row be written?", one row at a time, which
-- cannot express the rules that actually matter:
--
--   * a school must never be left without an owner
--   * an admin must not be able to demote the person who appointed them
--   * removing yourself by accident should not be possible
--
-- Each function raises a message meant to be shown to the person who tried.
-- ===========================================================================

-- --------------------------------------------------------------------------
-- Who is on the staff list
--
-- Replaces the version in 0003_roles.sql, which only knew about people who
-- had already signed in. An invited colleague who has not been in yet is the
-- one you most need to see, because you are about to wonder whether they got
-- the email.
-- --------------------------------------------------------------------------

drop function if exists school_staff();

create or replace function school_staff()
returns table (
  user_id     uuid,
  email       text,
  member_role text,
  signed_in   boolean,
  invited_at  timestamptz
)
language sql stable security definer set search_path = public
as $$
  -- People with an account.
  select m.user_id, u.email, m.role, true, i.created_at
  from memberships m
  join auth.users u on u.id = m.user_id
  left join staff_invites i on i.email = lower(u.email)
  where m.org_id in (select app_org_ids())

  union all

  -- Invited, but have not signed in yet: no account, so no membership.
  select null::uuid, i.email, i.role, false, i.created_at
  from staff_invites i
  where i.org_id in (select app_org_ids())
    and not exists (
      select 1 from memberships m
      join auth.users u on u.id = m.user_id
      where m.org_id = i.org_id and lower(u.email) = i.email)

  order by 4 desc, 2
$$;

grant execute on function school_staff() to authenticated;
revoke execute on function school_staff() from anon, public;

-- --------------------------------------------------------------------------
-- Helpers used by the three functions below
-- --------------------------------------------------------------------------

/** The school the caller administers, or null if they administer none. */
create or replace function app_admin_org()
returns uuid
language sql stable security definer set search_path = public
as $$
  select org_id from memberships
  where user_id = auth.uid() and role in ('owner','admin')
  limit 1
$$;

/** Schools the caller administers. SECURITY DEFINER so that a policy ON
 *  memberships can call it without asking memberships a question that would
 *  send it round in a circle. */
create or replace function app_admin_org_ids()
returns setof uuid
language sql stable security definer set search_path = public
as $$
  select org_id from memberships
  where user_id = auth.uid() and role in ('owner','admin')
$$;

create or replace function app_caller_is_owner(org uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from memberships
    where user_id = auth.uid() and org_id = org and role = 'owner')
$$;

-- --------------------------------------------------------------------------
-- Add a colleague
-- --------------------------------------------------------------------------

create or replace function invite_staff(addr text, new_role text default 'teacher')
returns void
language plpgsql security definer set search_path = public
as $$
declare
  org   uuid := app_admin_org();
  clean text := lower(trim(addr));
  taken uuid;
begin
  if org is null then
    raise exception 'Only an admin can add staff.';
  end if;
  if new_role not in ('teacher','admin','owner') then
    raise exception 'Choose teacher, admin or owner.';
  end if;
  if new_role = 'owner' and not app_caller_is_owner(org) then
    raise exception 'Only an owner can appoint another owner.';
  end if;
  if clean = '' or position('@' in clean) = 0 then
    raise exception 'That does not look like an email address.';
  end if;

  select org_id into taken from staff_invites where email = clean;
  if taken is not null and taken <> org then
    raise exception 'That address is already on another school''s staff list.';
  end if;

  insert into staff_invites (org_id, email, role, invited_by)
  values (org, clean, new_role, auth.uid())
  on conflict (org_id, email) do update set role = excluded.role;

  -- If they already have an account from somewhere, link them straight away
  -- rather than making them sign out and back in.
  insert into memberships (user_id, org_id, role)
  select u.id, org, new_role from auth.users u where lower(u.email) = clean
  on conflict (user_id, org_id) do update set role = excluded.role;
end $$;

-- --------------------------------------------------------------------------
-- Change what somebody may do
-- --------------------------------------------------------------------------

create or replace function set_staff_role(addr text, new_role text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  org     uuid := app_admin_org();
  clean   text := lower(trim(addr));
  was     text;
  owners  int;
  target  uuid;
begin
  if org is null then
    raise exception 'Only an admin can change what somebody may do.';
  end if;
  if new_role not in ('teacher','admin','owner') then
    raise exception 'Choose teacher, admin or owner.';
  end if;

  select i.role into was from staff_invites i where i.org_id = org and i.email = clean;
  if was is null then
    raise exception 'Nobody with that address is on your staff list.';
  end if;

  if (was = 'owner' or new_role = 'owner') and not app_caller_is_owner(org) then
    raise exception 'Only an owner can appoint or change another owner.';
  end if;

  if was = 'owner' and new_role <> 'owner' then
    select count(*) into owners from staff_invites where org_id = org and role = 'owner';
    if owners <= 1 then
      raise exception 'This is the only owner. Make somebody else an owner first, or the school would be left with nobody who can.';
    end if;
  end if;

  update staff_invites set role = new_role where org_id = org and email = clean;

  select u.id into target from auth.users u where lower(u.email) = clean;
  if target is not null then
    update memberships set role = new_role where user_id = target and org_id = org;
  end if;
end $$;

-- --------------------------------------------------------------------------
-- Remove somebody
--
-- Their sign-in account still exists — this is not ours to delete — but it
-- belongs to no school, so it can read nothing. Their marks stay: the work is
-- the school's, not the individual's, and deleting a colleague should never
-- quietly delete a term of marking.
-- --------------------------------------------------------------------------

create or replace function remove_staff(addr text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  org    uuid := app_admin_org();
  clean  text := lower(trim(addr));
  was    text;
  owners int;
  target uuid;
begin
  if org is null then
    raise exception 'Only an admin can remove staff.';
  end if;

  select i.role into was from staff_invites i where i.org_id = org and i.email = clean;
  if was is null then
    raise exception 'Nobody with that address is on your staff list.';
  end if;

  select u.id into target from auth.users u where lower(u.email) = clean;
  if target = auth.uid() then
    raise exception 'You cannot remove yourself. Ask another admin to do it.';
  end if;

  if was = 'owner' then
    if not app_caller_is_owner(org) then
      raise exception 'Only an owner can remove another owner.';
    end if;
    select count(*) into owners from staff_invites where org_id = org and role = 'owner';
    if owners <= 1 then
      raise exception 'This is the only owner. Make somebody else an owner first.';
    end if;
  end if;

  delete from staff_invites where org_id = org and email = clean;
  if target is not null then
    delete from assessment_teachers
    where user_id = target
      and assessment_id in (select id from assessments where org_id = org);
    delete from memberships where user_id = target and org_id = org;
  end if;
end $$;

grant execute on function invite_staff(text, text)   to authenticated;
grant execute on function set_staff_role(text, text) to authenticated;
grant execute on function remove_staff(text)         to authenticated;
revoke execute on function invite_staff(text, text)   from anon, public;
revoke execute on function set_staff_role(text, text) from anon, public;
revoke execute on function remove_staff(text)         from anon, public;

-- --------------------------------------------------------------------------
-- Assigning markers reads memberships to show who is who, so an admin needs
-- to see the memberships of their own school — not just their own row.
-- --------------------------------------------------------------------------

drop policy if exists mem_read_admin on memberships;
create policy mem_read_admin on memberships for select to authenticated
  using (org_id in (select app_admin_org_ids()));

-- ===========================================================================
-- EveryPupil — who is allowed in
--
-- Run this once in Supabase: SQL Editor -> New query -> paste -> Run.
-- Safe to run more than once.
--
-- The problem this solves: a school has sixty staff, and adding each of them
-- by hand in the Supabase dashboard is not a thing anybody will do. So staff
-- sign themselves in with their work email — but only if somebody at the
-- school has put that address on the list first.
--
-- Two independent things stand between a stranger and your pupil data:
--
--   1. The signup hook below refuses to create an account for an address that
--      is not on the list. That is what stops a stranger burning through your
--      email allowance requesting codes.
--
--   2. Even if the hook were switched off in the dashboard, an account with
--      no membership row can read NOTHING: every policy in 0001_schema.sql
--      goes through app_org_ids(), which returns nothing for them. Security
--      rests on the membership, not on the hook.
-- ===========================================================================

-- --------------------------------------------------------------------------
-- The staff list
-- --------------------------------------------------------------------------

create table if not exists staff_invites (
  org_id      uuid not null references organisations(id) on delete cascade,
  email       text not null,
  role        text not null default 'teacher'
              check (role in ('owner','admin','teacher')),
  invited_by  uuid references auth.users(id),
  created_at  timestamptz not null default now(),
  accepted_at timestamptz,
  primary key (org_id, email)
);

-- One address, one school. With a single school this is simply true, and it
-- keeps the lookup below unambiguous. Relaxing it is what lets somebody work
-- at two schools later; that is a deliberate decision, not an accident.
create unique index if not exists staff_invites_email on staff_invites (email);

-- Addresses arrive pasted from a staff list, so mixed case and stray spaces
-- are normal. Normalise on the way in rather than rejecting the paste.
create or replace function normalise_invite_email()
returns trigger language plpgsql as $$
begin
  new.email = lower(trim(new.email));
  return new;
end $$;

drop trigger if exists staff_invites_normalise on staff_invites;
create trigger staff_invites_normalise before insert or update on staff_invites
  for each row execute function normalise_invite_email();

-- --------------------------------------------------------------------------
-- Refuse an account to anybody who is not on the list
--
-- This is Supabase's "Before User Created" hook. Creating the function is not
-- enough on its own — it must also be switched on at
-- Authentication -> Hooks -> Before User Created. See supabase/README.md.
-- --------------------------------------------------------------------------

create or replace function hook_restrict_signup(event jsonb)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  addr text := lower(trim(coalesce(event->'user'->>'email', '')));
begin
  if addr = '' then
    return jsonb_build_object('error', jsonb_build_object(
      'http_code', 400,
      'message', 'An email address is required.'));
  end if;

  if not exists (select 1 from staff_invites where email = addr) then
    -- Deliberately says who to ask. A teacher who mistypes their address at
    -- 7.40am needs to know what to do next, not just that it did not work.
    return jsonb_build_object('error', jsonb_build_object(
      'http_code', 403,
      'message', 'That address is not on your school''s staff list. Ask whoever set up EveryPupil at your school to add it.'));
  end if;

  return '{}'::jsonb;
end $$;

-- Only the auth service may run it. Nobody signed in — and certainly nobody
-- signed out — has any business calling it directly.
grant usage on schema public to supabase_auth_admin;
grant execute on function hook_restrict_signup(jsonb) to supabase_auth_admin;
revoke execute on function hook_restrict_signup(jsonb) from authenticated, anon, public;

-- --------------------------------------------------------------------------
-- Turn an invitation into a membership
--
-- Two routes, because accounts and invitations can be created in either order:
--   * the trigger covers "invited first, signed in later" (the normal case)
--   * claim_membership() covers "account already existed, invited afterwards",
--     and is called by the app on every sign-in, so the order never matters.
-- --------------------------------------------------------------------------

create or replace function link_new_user_to_school()
returns trigger language plpgsql security definer set search_path = public
as $$
declare
  invite staff_invites%rowtype;
begin
  select * into invite from staff_invites where email = lower(trim(new.email));
  if found then
    insert into memberships (user_id, org_id, role)
    values (new.id, invite.org_id, invite.role)
    on conflict (user_id, org_id) do nothing;

    update staff_invites set accepted_at = now()
    where org_id = invite.org_id and email = invite.email;
  end if;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function link_new_user_to_school();

create or replace function claim_membership()
returns table (school_id uuid, member_role text, school_name text)
language plpgsql security definer set search_path = public
as $$
declare
  uid  uuid := auth.uid();
  addr text;
  invite staff_invites%rowtype;
begin
  if uid is null then return; end if;

  -- Read the address from auth.users rather than from the token, so a doctored
  -- token cannot claim somebody else's invitation.
  select lower(trim(email)) into addr from auth.users where id = uid;
  if addr is null then return; end if;

  select * into invite from staff_invites where email = addr;
  if found then
    -- The output columns are named school_id/member_role on purpose. Naming
    -- them org_id/role would shadow the table columns of the same name and
    -- make "on conflict (user_id, org_id)" below ambiguous — which fails at
    -- run time, not when the function is created.
    insert into memberships (user_id, org_id, role)
    values (uid, invite.org_id, invite.role)
    on conflict (user_id, org_id) do nothing;

    update staff_invites set accepted_at = coalesce(accepted_at, now())
    where staff_invites.org_id = invite.org_id and staff_invites.email = invite.email;
  end if;

  return query
    select m.org_id, m.role, o.name
    from memberships m join organisations o on o.id = m.org_id
    where m.user_id = uid
    order by m.created_at
    limit 1;
end $$;

grant execute on function claim_membership() to authenticated;
revoke execute on function claim_membership() from anon, public;

-- --------------------------------------------------------------------------
-- Who may see and edit the staff list
-- --------------------------------------------------------------------------

create or replace function app_is_admin(target uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from memberships
    where user_id = auth.uid() and org_id = target and role in ('owner','admin')
  )
$$;

-- Supabase grants privileges on new public tables automatically. Saying it
-- here anyway makes the intent explicit and does not depend on that default
-- still being in place: signed-in staff can work with the list, signed-out
-- visitors have no privilege on it at all.
grant select, insert, update, delete on staff_invites to authenticated;
revoke all on staff_invites from anon;

alter table staff_invites enable row level security;

drop policy if exists invites_read on staff_invites;
create policy invites_read on staff_invites for select to authenticated
  using (org_id in (select app_org_ids()));

drop policy if exists invites_write on staff_invites;
create policy invites_write on staff_invites for all to authenticated
  using (app_is_admin(org_id))
  with check (app_is_admin(org_id));

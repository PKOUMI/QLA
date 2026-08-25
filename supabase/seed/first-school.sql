-- ===========================================================================
-- Create your school and your own account. Run this ONCE, after the two
-- migrations, and edit the three lines marked EDIT ME first.
--
-- Run it in the Supabase SQL Editor like the others.
-- ===========================================================================

do $$
declare
  school_name  text := 'Your School Name';           -- EDIT ME
  your_email   text := 'you@yourschool.sch.uk';      -- EDIT ME  (your work address)
  school_id    uuid;
begin
  select id into school_id from organisations where name = school_name;

  if school_id is null then
    insert into organisations (name, kind, plan)
    values (school_name, 'school', 'school')
    returning id into school_id;
    raise notice 'Created school "%"', school_name;
  else
    raise notice 'School "%" already exists — using it', school_name;
  end if;

  insert into staff_invites (org_id, email, role)
  values (school_id, your_email, 'owner')
  on conflict (email) do update set org_id = excluded.org_id, role = 'owner';

  raise notice 'Added % as owner. Sign in at the app with that address.', your_email;
end $$;

-- ---------------------------------------------------------------------------
-- You should not need what follows. Once you can sign in, the Staff button in
-- the app adds colleagues, changes what they may do, and removes them — with
-- guards this file has no way to apply. Keep reading only if you would rather
-- paste a whole staff list in one go.
--
-- Adding the rest of your staff. One row each, addresses as they appear in
-- your MIS. Case and spacing do not matter. Roles:
--
--   teacher  enter marks on the assessments they are assigned to, and read
--            the school's assessments and analysis
--   admin    all of that, plus creating and editing assessments, managing
--            pupils, sending feedback, and adding and removing staff
--   owner    the same as admin (kept separate so there is always one)
--
-- Paste over the example rows and run just this statement.
-- ---------------------------------------------------------------------------

-- insert into staff_invites (org_id, email, role)
-- select o.id, v.email, v.role
-- from organisations o,
--      (values
--         ('a.teacher@yourschool.sch.uk', 'teacher'),
--         ('b.teacher@yourschool.sch.uk', 'teacher'),
--         ('head.of.science@yourschool.sch.uk', 'admin')
--      ) as v(email, role)
-- where o.name = 'Your School Name'                 -- EDIT ME (same name as above)
-- on conflict (email) do nothing;

-- Who is on the list, and who has actually signed in:
-- select email, role, accepted_at from staff_invites order by accepted_at nulls first, email;

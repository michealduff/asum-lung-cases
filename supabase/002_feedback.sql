-- ASUM Lung Cases: supervisor feedback
-- Paste into Supabase → SQL Editor → New query → Run (after setup.sql). Safe to run more than once.

-- Feedback left by the supervisor on a shared case.
create table if not exists public.feedback (
  id         uuid primary key default gen_random_uuid(),
  case_id    uuid not null references public.cases(id) on delete cascade,
  author     text,
  body       text not null check (length(body) between 1 and 5000),
  created_at timestamptz not null default now()
);
create index if not exists feedback_case_id_idx on public.feedback (case_id);

alter table public.feedback enable row level security;

-- You can read (and delete) feedback on your own cases.
drop policy if exists "owner reads feedback" on public.feedback;
create policy "owner reads feedback" on public.feedback for select to authenticated
  using (exists (select 1 from public.cases c where c.id = case_id and c.owner = auth.uid()));
drop policy if exists "owner deletes feedback" on public.feedback;
create policy "owner deletes feedback" on public.feedback for delete to authenticated
  using (exists (select 1 from public.cases c where c.id = case_id and c.owner = auth.uid()));

-- The supervisor (no login) can read and add feedback only on a case whose share link they hold.
create or replace function public.get_shared_feedback(token text)
returns table (id uuid, author text, body text, created_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select f.id, f.author, f.body, f.created_at
  from public.feedback f
  join public.cases c on c.id = f.case_id
  where token is not null and length(token) >= 20 and c.share_token = token
  order by f.created_at;
$$;

create or replace function public.add_shared_feedback(p_token text, p_author text, p_body text)
returns table (id uuid, author text, body text, created_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_case uuid;
begin
  if p_token is null or length(p_token) < 20 then
    raise exception 'This link is not valid';
  end if;
  select c.id into v_case from public.cases c where c.share_token = p_token;
  if v_case is null then
    raise exception 'This link has been turned off';
  end if;
  if p_body is null or length(trim(p_body)) = 0 then
    raise exception 'Feedback is empty';
  end if;
  return query
    insert into public.feedback as f (case_id, author, body)
    values (v_case, nullif(left(trim(coalesce(p_author, '')), 100), ''), left(trim(p_body), 5000))
    returning f.id, f.author, f.body, f.created_at;
end;
$$;

revoke all on function public.get_shared_feedback(text) from public;
revoke all on function public.add_shared_feedback(text, text, text) from public;
grant execute on function public.get_shared_feedback(text) to anon, authenticated;
grant execute on function public.add_shared_feedback(text, text, text) to anon, authenticated;

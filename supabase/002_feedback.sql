-- ASUM Lung Cases: supervisor feedback
-- Paste into Supabase → SQL Editor → New query → Run (after setup.sql). Safe to run more than once.
--
-- The supervisor's browser sends the case's secret share code in an "x-share-token" header.
-- These rules let that browser see the one matching case and read/add feedback on it, nothing else.

-- Feedback left by the supervisor on a shared case.
create table if not exists public.feedback (
  id         uuid primary key default gen_random_uuid(),
  case_id    uuid not null references public.cases(id) on delete cascade,
  author     text check (author is null or length(author) <= 100),
  body       text not null check (length(trim(body)) between 1 and 5000),
  created_at timestamptz not null default now()
);
create index if not exists feedback_case_id_idx on public.feedback (case_id);

alter table public.feedback enable row level security;

-- You can read and delete feedback on your own cases.
drop policy if exists "owner reads feedback" on public.feedback;
create policy "owner reads feedback" on public.feedback for select to authenticated
  using (exists (select 1 from public.cases c where c.id = case_id and c.owner = auth.uid()));

drop policy if exists "owner deletes feedback" on public.feedback;
create policy "owner deletes feedback" on public.feedback for delete to authenticated
  using (exists (select 1 from public.cases c where c.id = case_id and c.owner = auth.uid()));

-- Someone holding a share link can see that one case.
drop policy if exists "share link reads case" on public.cases;
create policy "share link reads case" on public.cases for select to anon, authenticated
  using (
    share_token is not null
    and length(share_token) >= 20
    and share_token = (current_setting('request.headers', true)::json ->> 'x-share-token')
  );

-- ...and read and add feedback on that case.
drop policy if exists "share link reads feedback" on public.feedback;
create policy "share link reads feedback" on public.feedback for select to anon, authenticated
  using (exists (
    select 1 from public.cases c
    where c.id = case_id
      and c.share_token is not null
      and length(c.share_token) >= 20
      and c.share_token = (current_setting('request.headers', true)::json ->> 'x-share-token')
  ));

drop policy if exists "share link adds feedback" on public.feedback;
create policy "share link adds feedback" on public.feedback for insert to anon, authenticated
  with check (exists (
    select 1 from public.cases c
    where c.id = case_id
      and c.share_token is not null
      and length(c.share_token) >= 20
      and c.share_token = (current_setting('request.headers', true)::json ->> 'x-share-token')
  ));

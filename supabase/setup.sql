-- ASUM Lung Cases: Supabase setup
-- Paste all of this into Supabase → SQL Editor → New query → Run. Safe to run more than once.

-- 1. Cases table. Everything about a case lives in `data` (JSON) so the form can change
--    without database migrations.
create table if not exists public.cases (
  id            uuid primary key default gen_random_uuid(),
  owner         uuid not null default auth.uid() references auth.users(id) on delete cascade,
  number        integer not null,
  data          jsonb not null default '{}'::jsonb,
  share_token   text unique,           -- secret part of the supervisor link; null = not shared
  shared_videos jsonb not null default '[]'::jsonb,  -- signed video URLs for the supervisor view
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (owner, number)
);

alter table public.cases enable row level security;

-- Only you can see and change your own cases.
drop policy if exists "owner can do everything" on public.cases;
create policy "owner can do everything" on public.cases
  for all to authenticated
  using (owner = auth.uid())
  with check (owner = auth.uid());

-- 2. Supervisor access: anyone holding the secret link token can read that one case,
--    and nothing else. (No login needed for the supervisor.)
create or replace function public.get_shared_case(token text)
returns table (number integer, data jsonb, shared_videos jsonb, updated_at timestamptz)
language sql
security definer
set search_path = public
as $$
  select c.number, c.data, c.shared_videos, c.updated_at
  from public.cases c
  where token is not null and length(token) >= 20 and c.share_token = token;
$$;

revoke all on function public.get_shared_case(text) from public;
grant execute on function public.get_shared_case(text) to anon, authenticated;

-- 3. Private storage bucket for scan videos (50 MB per file, video only).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('videos', 'videos', false, 52428800, array['video/*'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- Files are stored under "<your user id>/<case id>/<file>"; only you can read/write your folder.
-- The supervisor gets time-limited signed links instead.
drop policy if exists "owner videos select" on storage.objects;
drop policy if exists "owner videos insert" on storage.objects;
drop policy if exists "owner videos update" on storage.objects;
drop policy if exists "owner videos delete" on storage.objects;

create policy "owner videos select" on storage.objects for select to authenticated
  using (bucket_id = 'videos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "owner videos insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'videos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "owner videos update" on storage.objects for update to authenticated
  using (bucket_id = 'videos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "owner videos delete" on storage.objects for delete to authenticated
  using (bucket_id = 'videos' and (storage.foldername(name))[1] = auth.uid()::text);

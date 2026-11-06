-- ASUM Lung Cases: supervisor's Yes/No answers for the ASUM logbook
-- ("Adequate images?" and "Correct interpretation?").
-- Paste into Supabase → SQL Editor (Database, not Logs) → New query → Run.
alter table public.feedback add column if not exists adequate_images boolean;
alter table public.feedback add column if not exists correct_interpretation boolean;

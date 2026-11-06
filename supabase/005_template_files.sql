-- ASUM Lung Cases: also allow the ASUM logbook template (.xlsx) in your private storage.
-- Paste into Supabase → SQL Editor (Database, not Logs) → New query → Run.
update storage.buckets
set allowed_mime_types = array['video/*', 'image/*', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']
where id = 'videos';

-- ASUM Lung Cases: allow images (e.g. CXR / CT photos) in the private media bucket.
-- Paste into Supabase → SQL Editor (Database, not Logs) → New query → Run.
update storage.buckets
set allowed_mime_types = array['video/*', 'image/*']
where id = 'videos';

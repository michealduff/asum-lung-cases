# ASUM Lung Cases

A simple web app for writing up PoCUS lung ultrasound cases and sharing them with a supervisor.

- Numbered cases (#1, #2, …)
- Tap-to-fill form following the lung ultrasound template: indication, R1–R4, R-PLAPS, L1–L4, L-PLAPS, interpretation and integration
- Zone map that colours each zone as normal or abnormal, plus pattern suggestions (e.g. ≥2 B-line-positive zones on each side suggests bilateral interstitial syndrome)
- Upload scan videos from an iPhone
- Report text you can copy or download, and a read-only "Supervisor view"

Live site: https://michealduff.github.io/asum-lung-cases/

## How it works

- Static site hosted on GitHub Pages (pushing to `main` updates it).
- Data lives in Supabase (Sydney): cases in the `cases` table, videos in the private `videos` bucket.
  Setup SQL is in `supabase/setup.sql`; the connection details are in `config.js`.
- Only the owner can sign in (public sign-ups are disabled in Supabase).
- "Create share link" gives a case a secret token. The supervisor link `#s/<token>` shows that one case
  read-only, with video links that last 90 days. "Stop sharing" turns the link off.
- If `config.js` is blank the app runs in local-only mode (data stays in the browser).

Do not enter patient identifiers. Check that clips don't show patient details on the machine screen.

## Run locally

```bash
node serve.js 8123
```

Then open http://localhost:8123.

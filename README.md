# ASUM Lung Cases

A simple web app for writing up PoCUS lung ultrasound cases and sharing them with a supervisor.

- Numbered cases (#1, #2, …)
- Tap-to-fill form following the lung ultrasound template: indication, R1–R4, R-PLAPS, L1–L4, L-PLAPS, interpretation and integration
- Zone map that colours each zone as normal or abnormal, plus pattern suggestions (e.g. ≥2 B-line-positive zones on each side suggests bilateral interstitial syndrome)
- Upload scan videos from an iPhone
- Report text you can copy or download, and a read-only "Supervisor view"

## Current status (prototype)

Everything is stored **in the browser on this device only**: cases in localStorage, videos in IndexedDB. Sharing with a supervisor by link needs online hosting and storage, which hasn't been chosen yet.

Do not enter patient identifiers. Check that clips don't show patient details on the machine screen.

## Run locally

```bash
node serve.js 8123
```

Then open http://localhost:8123.

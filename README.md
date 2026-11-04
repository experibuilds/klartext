# Klartext

Snap or upload a German document → plain-English summary, a clear "action required?" verdict with deadline, step-by-step next actions, and the full translation.

**Live:** https://klartext.vercel.app

- Accepts PDF (text or scanned), photos (JPG/PNG/HEIC/WebP), Word (.docx), text/HTML/email files, and direct camera capture (multi-page).
- Installable PWA (Add to Home Screen); Android can share files straight into it.
- Free stack: static page + one Vercel function (`api/analyze.js`), Groq (`gpt-oss-120b` text, `qwen3.8-27b` vision) → OpenRouter free fallback.
- Nothing is stored.

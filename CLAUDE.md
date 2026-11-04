# Klartext — rules for Claude Code

App: static PWA `public/` (index.html, app.js, styles.css, sw.js) + serverless `api/analyze.js` (Groq → OpenRouter free fallback; text models for PDFs/Word, vision models for photos/scans). Hosted on Vercel, repo on GitHub.

## Every iteration
1. Make the change. Keep it small and focused.
2. Test locally: `npx vercel dev` → http://localhost:3000 (keys from ../.ai-api-keys.env). Bump `CACHE` in public/sw.js when shell files change.
3. Ship: `./ship.sh "<type>: <summary>" [patch|minor|major]`
   - types: feat, fix, style, refactor, docs, chore
   - patch = fixes, minor = features, major = breaking
4. Report the version and the live URL.

## Bigger changes
Create a branch `feat/<name>`, push, open a PR with `gh pr create --fill` → Vercel posts a preview link. Merge to main to go live.

## Never
- Commit secrets or `.env*` files. The key lives only in Vercel env vars.
- Push directly if tests/local run fail.

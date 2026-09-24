# Agent notes

Primary instructions: [CLAUDE.md](CLAUDE.md)

This repo is the full InnNorsk codebase: the cloud web app (`server/`, `web/`, deployed to Render via `render.yaml` + `Dockerfile`) and the Windows Electron app, sharing the translation core in `src/`. GitHub Pages (`docs/index.html`) is only the Windows download page.

Tests and agents must never call the real xAI API. Use `test/helpers/mock-grok.js` or `test/helpers/mock-xai-server.js`.

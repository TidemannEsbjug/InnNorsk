# Agent notes

Primary instructions: [CLAUDE.md](CLAUDE.md).

InnNorsk = Cloudflare Worker (`worker/`, D1, R2, Workflow that translates via the xAI API) + static UI (`web/`) + shared translation core (`src/`), plus the legacy Windows Electron app. Deploy: [docs/DEPLOY.md](docs/DEPLOY.md).

The repo is public: never commit keys or passwords. Tests and agents must never call the real xAI API or APNs — use `test/helpers/mock-grok.js`, `test/helpers/mock-xai-server.js`, `test/helpers/mock-apns.js`.

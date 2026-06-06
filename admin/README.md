# CareBrain Admin — Observability log viewer

A small **Next.js** app (App Router, **client-rendered SPA — `output: 'export'`, no SSR**)
that visualizes the Patient Q&A assistant's observability audit log. It reads the backend's
`GET /qa/logs` and renders it as a sortable / filterable **ShadCN data table** (TanStack
Table); clicking any row opens a **detail Sheet** with the full request trace. Themed to the
CareBrain brand (lavender / periwinkle, Plus Jakarta Sans).

## Run

```bash
cp .env.example .env.local      # defaults point at the backend on :3000
npm install
npm run dev                     # http://localhost:3200
```

Requires the **Nest backend running on :3000** (it serves `/auth/session` and `/qa/logs`).
Sign in with `admin` / `admin` (configurable — see below).

- `npm run build` → static export to `out/` (deploy to any static host).
- `npm run dev` runs the dev server on port **3200** (the backend uses 3000).
- `npm run start` builds the static export and serves `out/` on **3200** via `serve`
  (`next start` cannot serve an `output: 'export'` build, so it is not used).

## How it works

- **Auth.** A primitive login gate ([lib/auth.ts](lib/auth.ts)) checks the credentials, then
  mints a cohort session token via `POST /auth/session` and stores it in `localStorage`. That
  token authorizes the `/qa/logs` calls (`Authorization: Basic <token>`). Logs span both
  cohorts regardless of the token's group.
- **Data.** [lib/api.ts](lib/api.ts) fetches the log; [lib/types.ts](lib/types.ts) mirrors the
  backend `request_log` shape. The list returns full rows, so the detail Sheet needs no extra
  request.
- **UI.** [components/logs-table.tsx](components/logs-table.tsx) +
  [components/columns.tsx](components/columns.tsx) (table) and
  [components/log-detail-sheet.tsx](components/log-detail-sheet.tsx) (drawer).

## Configuration (`.env.local`)

| Variable | Default | Notes |
|----------|---------|-------|
| `NEXT_PUBLIC_API_URL` | `http://localhost:3000` | Backend base URL |
| `NEXT_PUBLIC_ADMIN_USER` | `admin` | Login username |
| `NEXT_PUBLIC_ADMIN_PASSWORD` | `admin` | Login password |

> **⚠️ The login is a UI gate only, not real auth.** `NEXT_PUBLIC_*` values are inlined into
> the browser bundle, so they are not secret. A real deployment would gate `/qa/logs` behind a
> server-side admin role (see `../SECURITY.md`).

## Troubleshooting

If `npm run dev` fails with `Cannot find module '…lightningcss.darwin-arm64.node'`, your global
`~/.npmrc` likely contains `os=macos` (npm expects `darwin`), which makes npm skip the
platform-specific optional binaries Tailwind v4 needs. Fix the `~/.npmrc`, or install the
binary explicitly:

```bash
npm install lightningcss-darwin-arm64 --os=darwin --cpu=arm64 --no-save
```

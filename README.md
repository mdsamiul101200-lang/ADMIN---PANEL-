# Payment & Order Admin Panel

Secure admin panel with its own backend. The browser never talks to the provider and never sees API keys.
**No `npm install` needed** (zero dependencies; requires Node 22.13+ or the included Dockerfile).

```
Browser -> this server (login, roles, CSRF, audit) -> paymentService adapter -> provider API
```

## 1) Put the code on GitHub (no folder upload needed)
1. Create a new empty repository on GitHub.
2. In the repo choose **Add file -> Create new file**, name it `.github/workflows/unzip.yml`, paste the contents of the `unzip.yml` file that came with this download, and commit.
3. Upload `payment-admin-panel.zip` to the repo root (**Add file -> Upload files**), and commit.
4. Open the **Actions** tab. The "Unzip project" workflow runs, extracts every file into the repo, deletes the zip and commits. If it did not start, open it and press **Run workflow**.
5. Refresh the repo: `backend/`, `frontend/`, `Dockerfile`, `README.md` ... should now be there.

(GitHub does not let a workflow overwrite files inside `.github/`, so the workflow file is added by hand in step 2.)

## 2) Deploy with Docker
The repo has a `Dockerfile`. Create an app from the GitHub repo on your Docker host, build type **Dockerfile**, port **3000**, then set these environment variables:

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `SESSION_SECRET` | random text, 32+ characters |
| `API_BASE_URL` | `https://api.dkwinapi.com/api/webapi` |
| `API_KEY` / `API_SECRET` | from your provider |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | first login (12+ chars). Remove `ADMIN_PASSWORD` after first login |
| `DATABASE_URL` | `/app/data/admin.db` |

**Important:** add a persistent volume mounted at `/app/data`, otherwise the database (orders, audit log, admins) is erased on every redeploy.
Use HTTPS (a domain). If you test over plain `http://` set `COOKIE_SECURE=false`, otherwise login will not stick.
Health check URL: `/healthz`.

## 3) Run on your own computer (optional)
```bash
cp .env.example .env     # fill values
npm start                # http://localhost:3000
npm test                 # 56 automated checks against a mock provider
```

## Provider mapping (must verify)
The provider's exact request/response formats were not supplied, so they are isolated in `backend/services/paymentService.js`:
`PAYLOADS` (request fields), `normalize()` (response mapping), and `.env` (`API_KEY_HEADER`, `API_KEY_PREFIX`, `SIGN_REQUESTS`, `STATUS_MAP_JSON` for numeric statuses).
Unknown statuses never change an order. Test all 9 endpoints with a test account before real money.
The automated tests use a mock provider, **not** the real one.

## Orders
The provider has no "list orders" call here, so orders enter via **New order** (CreateRechargeOrder) or **Track order** (by ID). Dashboard numbers come only from these real records.

## Roles
SUPER_ADMIN / ADMIN: everything. OPERATOR: view, refresh, submit UTR. VIEWER: read-only. Checked on the server for every request.

## Not included
2FA; PostgreSQL (SQLite is used); WebSocket/SSE (the Pending page polls and pauses when the tab is hidden).

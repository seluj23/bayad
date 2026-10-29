# Bayad

Bills, income, and money friends owe you. Works offline on your phone (SQLite in the app) and syncs to your own server when you sign in with Google.

## How it fits together

- **On the phone:** the app keeps a full SQLite database in its private storage. Everything works with no internet.
- **On your server:** `server.js` serves the app and a sync API. Synced data lives in `/data/bayad-server.sqlite3`.
- **Sync:** each bill, income entry and loan carries a last-changed time. When devices disagree, the most recent change wins. Deletes sync too. Sync runs when the app opens, a couple of seconds after you change something, when you come back online, and when you tap **Sync now**.
- Sample entries never sync. They're removed from a device once it pulls your real data.

## 1. Create the Google sign-in client

1. Go to Google Cloud Console and create a project (or use an existing one).
2. **APIs & Services → OAuth consent screen:** choose *External*, fill in the app name and your email. While it's in *Testing*, only the Google accounts you add under **Test users** can sign in, which is fine for personal use. Add your Gmail there.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**
   - Application type: **Web application**
   - Authorized redirect URI: `https://YOUR-DOMAIN/auth/google/callback`
4. Copy the **Client ID** and **Client secret**.

The app only asks for `openid` and `email`, so it can't see your Drive, Gmail or anything else.

### Opening sign-in to everyone

While the consent screen is in *Testing*, only test users can sign in. To let anyone sign in:

1. Set `CONTACT_EMAIL` and leave `ALLOWED_EMAILS` empty, then deploy.
2. **OAuth consent screen → Branding**, fill in:
   - App logo: `public/icons/logo-120.png` (120×120)
   - Application home page: `https://YOUR-DOMAIN/about`
   - Privacy policy: `https://YOUR-DOMAIN/privacy`
   - Terms of service: `https://YOUR-DOMAIN/terms`
   - Authorized domain: your domain (verify it in Google Search Console if asked)
3. **Audience → Publish app.** Because the app only uses `openid` and `email`, Google reviews the branding only, not a full security assessment.

The privacy policy describes what this code does. If you change what the app collects or who it shares data with, update `public/privacy.html` too.

## 2. Deploy on Dokploy

1. Push this folder to a Git repository.
2. In Dokploy, create an **Application** from the repo. Build type: **Dockerfile**.
3. **Environment:** add the variables from `.env.example` (`PUBLIC_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ALLOWED_EMAILS`, `CONTACT_EMAIL`).
4. **Mounts / Volumes:** add a volume mounted at `/data`. Without it, synced data is lost on every redeploy.
5. **Domains:** add your domain, container port **3000**, with HTTPS on.
6. Deploy, then open the domain on your phone, install the app, and tap **Sign in with Google** under *Sync, backup & install*.

## Households

Signed-in people can create a household under *Sync & backup → Household* and invite others with a one-time link (valid 7 days), as a **member** or a **viewer**:

- **Owner:** everything below, plus invites, roles and removing people. Can hand ownership to someone else.
- **Member:** add, edit and record payments on shared bills; delete the shared bills they added.
- **Viewer:** sees shared bills, can't change them.

Each bill is either just yours or shared, chosen on the bill form. Loans and debts are always personal. Every payment records who made it, and members can get a notification when someone pays a shared bill. The server enforces the roles; the app only hides what someone can't do.

Each person can be in one household. When the owner leaves, the longest-standing member becomes the owner; when the last person leaves, the household and its shared bills are deleted.

## Reminders

Signed-in people can turn on two kinds of reminders under *Sync & backup → Reminders*:

- **Notifications:** standard Web Push, no Firebase or other account needed, and free. Each device that turns them on gets one message a day at 8 AM local time (`REMINDER_HOUR`) when something is due today or tomorrow, or a bill is overdue. The server creates its signing keys on first start and keeps them in `/data/vapid.json`. Keep that file: if it's lost, every device has to turn notifications on again. On iPhone, notifications only work after adding Bayad to the Home Screen (iOS 16.4 or later).
- **Calendar:** a private `/cal/<secret>.ics` feed people add to Google Calendar, Apple Calendar or Outlook. It lists unpaid due dates with a reminder at 9 AM the day before. Calendar apps refresh it every few hours.

Both use synced data, so they only cover entries that have synced to the server.

## Limits

Each account can sync up to 5000 bills, income entries and loans (`MAX_RECORDS_PER_USER`). Past that, new entries stay on the phone and the app says the synced storage is full. Sign-in is limited to 30 requests a minute per address, the API to 300, and syncing to 120 per account.

## Updating the app

After changing anything in `public/`, bump `VERSION` in `public/sw.js` (e.g. `bayad-v4`) so installed copies pick up the new files.

## Backups

- **Server:** once a day the server writes a snapshot to `/data/backups/bayad-YYYY-MM-DD.sqlite3` and keeps the last 7 (`BACKUP_KEEP`). These sit on the same volume, so they protect against bad deletes and a corrupted file but not against losing the volume. For that, turn on Dokploy's volume backups to S3 (or any S3-compatible storage) for the `/data` volume. To restore, stop the app, replace `bayad-server.sqlite3` with a snapshot, and start it again.
- **Phone:** *Download database (.sqlite)* in the app.

## Run locally

```
node server.js                       # http://localhost:3000, sign-in disabled
DEV_FAKE_LOGIN=1 node server.js      # adds /auth/dev?email=you@example.com for testing sync. Never use in production.
```
Requires Node 22 or newer (uses the built-in `node:sqlite`). No npm install needed.

## Tests

```
npm test
```
Runs the checks in `test/` with Node's built-in test runner: due-date rules, reminder encryption and calendar output, and a real server process covering sync, limits, account deletion and security headers. GitHub runs them on every push (`.github/workflows/test.yml`), along with a Docker build.

## License

MIT. See [LICENSE](LICENSE). The bundled SQLite build in `public/sqlite/` keeps its own terms: SQLite is public domain, and the `@sqlite.org/sqlite-wasm` wrapper is Apache-2.0.

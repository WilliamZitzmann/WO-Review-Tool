# Access-control Worker — deploy guide

I can't deploy or test this myself (no Cloudflare access from this environment, and I can't reach your VPN'd Maximo instance either), so this is a from-scratch walkthrough. Everything here is free-tier — Cloudflare Workers' free tier is 100,000 requests/day, and this design needs no paid features (no KV, no Durable Objects).

## What this actually buys you (read this before deploying)

This gates **casual/unauthorized use** — stops link-sharing, stops a deprovisioned user's old bookmarklet from still working, keeps the tool source and the permissions list off any public URL. It is **not** a hard security boundary: identity comes from a client-reported `whoami` claim, and this Worker cannot independently verify it against Maximo (Maximo is VPN-only, unreachable from the public Cloudflare edge). A user willing to lie about their own session before the token is issued isn't stopped by this. Treat it as governance, not a lock.

Encryption of the request body was considered and deliberately skipped — TLS already covers transit, and app-layer crypto wouldn't stop anyone who can already read the plaintext in their own browser's devtools.

## 1. Create a second, private repo

The Worker needs somewhere private to fetch `wo_tool.js` and `permissions.json` from. **Don't make your existing public repo private** — that repo also serves GitHub Pages (the guide) and the public orchestration files (`bookmarklet.js`, `loader.js`, `version.json`, `configs/`), none of which are sensitive, and flipping it private would need a paid GitHub plan to keep Pages working, plus it'd break every currently-installed bookmarklet the moment you did it.

Instead:
1. Create a new **private** repo, e.g. `WO-Review-Tool-Private`.
2. Copy `wo_tool.js` into it.
3. Create `permissions.json` in it — use `access-control/permissions.example.json` (in the public repo) as the template. **This is the only file with the real allow/deny/override rules and real usernames — it must only ever exist in the private repo.**
4. Going forward, whenever you update `wo_tool.js`, push it to *both* repos (public, for anyone still on the old direct-fetch bookmarklet during rollout, and private, for the new gated flow) until you're fully cut over — then stop updating the public copy.

## 2. Create a GitHub fine-grained PAT

GitHub Settings → Developer settings → Fine-grained personal access tokens → Generate new token.
- Repository access: **both** `WO-Review-Tool-Private` **and** `WO-Review-Tool` (a fine-grained PAT can cover more than one repo — this is deliberate: the admin layer below needs to write `permissions.json`/`buckets.json`/`adminGroups.json`/`admin.html` in the private repo AND `version.json` in the public repo, and a single Worker environment is the real trust boundary regardless of PAT count, so splitting into two PATs wouldn't buy real isolation, just an extra secret to rotate).
- Permissions: **Contents: Read and write** on both repos, plus **Issues: Read and write** on the private repo (needed for the `/feedback` endpoint, which files bug/suggestion reports as Issues there). Nothing else.
- Set an expiration and put a calendar reminder to rotate it — still a real credential, even scoped this tightly.

Copy the token now; GitHub won't show it again.

If you already have a PAT deployed from before the admin layer existed, it only has Contents:Read-only on the private repo — edit its permissions on GitHub (fine-grained PATs can be edited in place, no need to regenerate) to add Contents:Read-and-write on both repos, or every `/admin/*` write will fail with a GitHub 403.

## 3. Install Wrangler and log in

```
npm install -g wrangler
wrangler login
```

This opens a browser to authorize Wrangler against your Cloudflare account (free account is fine — sign up at cloudflare.com if you don't have one).

## 4. Set the secrets

From this `access-control/` directory:

```
wrangler secret put GITHUB_PAT
```
(paste the PAT from step 2 when prompted)

```
wrangler secret put TOKEN_SECRET
```
(paste any long random string — e.g. generate one with `openssl rand -hex 32`, or in a browser console: `crypto.getRandomValues(new Uint8Array(32)).reduce((s,b)=>s+b.toString(16).padStart(2,'0'),'')`)

```
wrangler secret put ROOT_ADMIN_TOKEN
```
(same generation method as `TOKEN_SECRET` — this is the unconditional, break-glass credential for the admin tool at `/admin`. It always grants full access regardless of what's in `adminGroups.json`, so treat it like a master password: store it somewhere durable outside the browser, e.g. a password manager. See `PERMISSIONS_GUIDE.md`'s "Buckets, field levels & delegated admin groups" section for the full admin model before you start delegating.)

```
wrangler secret put ADMIN_SESSION_SECRET
```
(same generation method — signs the session tokens issued by `/admin/login` once someone signs in with a real email/password, distinct from `TOKEN_SECRET` on purpose so the regular-user and admin credential classes never share a trust domain.)

```
wrangler secret put RESEND_API_KEY
```
(**optional.** A [Resend](https://resend.com) API key — get one free at resend.com. If set (along with `RESEND_FROM_EMAIL` in `wrangler.toml`, step 5), new admin accounts and password resets get a one-time emailed setup link instead of a temp password shown once in the admin UI. Skip this entirely and everything still works via the temp-password fallback — it's a pure upgrade, no code change needed either way, just this secret + that one var.)

## 5. Edit wrangler.toml

Open `wrangler.toml` and confirm/change:
- `GITHUB_OWNER` — your GitHub username.
- `GITHUB_REPO` — the private repo's name from step 1.
- `GITHUB_PUBLIC_REPO` — the public repo's name (`WO-Review-Tool` by default) — used by the admin tool's Version tab to read/write `version.json`.
- `GITHUB_BRANCH` — usually `main`.
- `RESEND_FROM_EMAIL` — only matters if you set `RESEND_API_KEY` above; the "from" address on account-setup/reset emails. `onboarding@resend.dev` works immediately with zero domain verification, but only delivers to the email your Resend account itself is registered under — fine for testing, swap to a verified real address before delegating to anyone else.

## 6. Deploy

```
wrangler deploy
```

Wrangler prints the deployed URL, something like `https://wo-review-tool-access.<your-subdomain>.workers.dev`. That's your `WORKER_BASE_URL` — you'll paste it into `loader.js`.

## 7. Test the three endpoints

```
curl https://<your-worker-url>/bootstrap
```
Should return `{"maximoHosts":[...],"requiredFields":[...]}` reflecting whatever's in your private repo's `permissions.json`.

```
curl -X POST https://<your-worker-url>/check-access \
  -H "Content-Type: application/json" \
  -d '{"fields":{"username":"ZITZMWX","insertSite":"AVWP","country":"IE","email":"william.zitzmann@abbvie.com"}}'
```
Should return `{"granted":true,"tier":"...", "token":"..."}` for a user your rules allow, or `{"granted":false}` otherwise.

```
curl "https://<your-worker-url>/tool?token=<token from above>"
```
Should return the full `wo_tool.js` source. Try it again with the same token after ~2 minutes — it should now 403 (expired).

## 7b. Set up the admin tool

The admin tool (`permissions.json`/`buckets.json`/`adminGroups.json`/`version.json` management without hand-editing on GitHub) needs a few more one-time steps before it works, on top of the `ROOT_ADMIN_TOKEN`/`ADMIN_SESSION_SECRET` secrets from step 4:

1. In the private repo, create two empty seed files (the admin tool bootstraps everything else from here via `/admin`):
   ```
   buckets.json      → {"buckets": []}
   adminGroups.json  → {"rootAccounts": [], "groups": []}
   ```
2. Also commit `admin.html` to the private repo (the admin page itself — served through the Worker at `/admin`, same pattern as `wo_tool.js`).
3. Test the shell and a real admin call:
   ```
   curl https://<your-worker-url>/admin
   ```
   Should return the admin page's HTML with `Cache-Control: no-store` in the response headers — no token needed to load the shell, only to do anything with it.
   ```
   curl -H "Authorization: Bearer <your ROOT_ADMIN_TOKEN>" https://<your-worker-url>/admin/permissions
   ```
   Should return `{"role":"root", ...}` with your full `permissions.json` contents.
4. **Bootstrap yourself a real root account** (so you're not retyping `ROOT_ADMIN_TOKEN` every visit — see PERMISSIONS_GUIDE.md's "Root" section):
   ```
   curl -X POST https://<your-worker-url>/admin/root-accounts \
     -H "Authorization: Bearer <your ROOT_ADMIN_TOKEN>" -H "Content-Type: application/json" \
     -d '{"email":"you@yourcompany.com","label":"Your Name"}'
   ```
   Without `RESEND_API_KEY`/`RESEND_FROM_EMAIL` configured (see step 4's secret list), returns `{"ok":true,"account":{...},"tempPassword":"..."}` — the temp password is shown **once**; open `/admin` in a browser, sign in with that email/temp password, and you'll be prompted to set a real one immediately. With Resend configured, returns `{"ok":true,"account":{...},"emailSent":true}` instead — you'll get a setup-link email at that address to click and set your own password. Keep `ROOT_ADMIN_TOKEN` itself tucked away as the break-glass fallback ("Use a break-glass token instead" link on the login screen) rather than your everyday credential.

From there, open `/admin` in a browser, paste your `ROOT_ADMIN_TOKEN`, and start building out buckets/field levels/admin groups — see `PERMISSIONS_GUIDE.md`'s "Buckets, field levels & delegated admin groups" section for the model (hierarchy, who can delegate what, the ancestor-condition "hardlock" that keeps a delegated admin's rules confined to their branch).

## 8. Wire up loader.js

Set `WORKER_BASE_URL` at the top of `loader.js` to your deployed Worker URL, commit, push to the **public** repo (loader.js itself has no secrets in it — it's just orchestration).

## 9. Roll out, then retire the old direct-fetch path

Once you've verified the new flow end-to-end (a real login on the real Maximo instance, not just curl), you can stop pushing `wo_tool.js` updates to the public repo and rely on the private one exclusively. Existing users' bookmarklets don't need to change — `bookmarklet.js` (the actual thing pasted into a browser bookmark) now just fetches `loader.js`, and that's the piece doing the domain-check/access-check/token dance before ever touching `wo_tool.js`.

## Releasing a new version — what's different now

`wo_tool.js`'s own self-update mechanism (the in-tool "check for updates" / "install update" flow, not just the bookmarklet's first load) now also goes through this Worker — it re-runs the same whoami/access-check dance and fetches the new source via `/tool`, instead of pulling straight from a public raw URL like it used to. That closes the gap where a revoked user's already-running tool could just keep self-updating forever with no access check. The consequence: **every release now needs tagging in *both* repos, not just the public one.**

Per release, in addition to whatever you already do in the public repo:
```
cd path/to/WO-Review-Tool-Private
cp path/to/wo_tool.js .
git add wo_tool.js && git commit -m "vX.Y.Z"
git tag vX.Y.Z
git push origin main && git push origin vX.Y.Z
```
Skipping this means anyone pinned to an exact version, or anyone whose auto-patch install tries to fetch that tag, gets a clear `GitHub fetch failed for wo_tool.js@vX.Y.Z: HTTP 404` from the Worker instead of the update — the currently-running tool keeps working either way (it never overwrites itself until the new source downloads successfully), it just won't update until the tag exists.

The "dev channel" (unpinned tip-of-branch) doesn't need a tag at all — it always reads whatever `GITHUB_BRANCH` (`main` by default) currently holds in the private repo, same as before.

## Rotating things later

- **PAT expired/compromised**: revoke it on GitHub, generate a new one, `wrangler secret put GITHUB_PAT` again, no redeploy needed (secrets update live).
- **TOKEN_SECRET rotated**: same — `wrangler secret put TOKEN_SECRET`. Any tokens issued under the old secret stop verifying immediately (they're short-lived anyway, ~2 minutes).
- **ROOT_ADMIN_TOKEN rotated/compromised**: same — `wrangler secret put ROOT_ADMIN_TOKEN`. Unlike the other two, this one is long-lived by design (it's the break-glass admin credential, not a short-lived session token), so rotate it deliberately rather than on a timer — and re-share the new value with yourself (and only yourself) the same way you'd handle any other master credential.
- **A delegated admin's token compromised**: no secret rotation needed — revoke it directly in the admin tool (`DELETE /admin/groups/:id/members/:memberId`, or delete the whole group if the group itself is compromised). Takes effect immediately (admin reads are always live, never cached).
- **permissions.json changed**: just commit to the private repo — the regular-user-facing `/bootstrap`/`/check-access` path fetches it fresh within its ~30s edge cache TTL; `/admin/*` reads are always live, no caching at all.

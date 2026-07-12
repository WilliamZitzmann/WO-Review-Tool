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
- Repository access: **only** `WO-Review-Tool-Private`.
- Permissions: **Contents: Read-only**. Nothing else.
- Set an expiration and put a calendar reminder to rotate it — a fine-grained PAT scoped to Contents:Read on one private repo is low-blast-radius, but it's still a real credential.

Copy the token now; GitHub won't show it again.

## 3. Install Wrangler and log in

```
npm install -g wrangler
wrangler login
```

This opens a browser to authorize Wrangler against your Cloudflare account (free account is fine — sign up at cloudflare.com if you don't have one).

## 4. Set the two secrets

From this `access-control/` directory:

```
wrangler secret put GITHUB_PAT
```
(paste the PAT from step 2 when prompted)

```
wrangler secret put TOKEN_SECRET
```
(paste any long random string — e.g. generate one with `openssl rand -hex 32`, or in a browser console: `crypto.getRandomValues(new Uint8Array(32)).reduce((s,b)=>s+b.toString(16).padStart(2,'0'),'')`)

## 5. Edit wrangler.toml

Open `wrangler.toml` and confirm/change:
- `GITHUB_OWNER` — your GitHub username.
- `GITHUB_REPO` — the private repo's name from step 1.
- `GITHUB_BRANCH` — usually `main`.

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
- **permissions.json changed**: just commit to the private repo — the Worker fetches it fresh on every request (no caching to invalidate).

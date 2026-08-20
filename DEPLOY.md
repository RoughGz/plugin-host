# Deploying to BeamUp — full guide

This repo auto-deploys to **BeamUp** (free Stremio addon hosting, dokku-based)
on every push to `main`. This guide explains how it works, how to set it up from
scratch, and how to fix it when something breaks.

---

## 1. How BeamUp works

BeamUp is a [dokku](https://dokku.com) host. Deploying = pushing your git repo
to it:

```
git push dokku@a.baby-beamup.club:<app-id>/<app-name> master
```

The host then builds the app (Node buildpack — it sees `package.json`), starts
it with a `PORT` env var, runs healthchecks, and serves it at:

```
https://<app-id>-<app-name>.baby-beamup.club/
```

**SSH keys are managed through your GitHub account.** BeamUp has no key
dashboard — instead it fetches the public keys from `github.com/<username>.keys`
and registers them on the host. That's why:

- the deploy key's **public** half must be added to your GitHub account
  (Settings → SSH and GPG keys), and
- the host must be told to re-sync (`sync-github-keys <username>` — the `beamup`
  CLI does this automatically; this repo's setup does it too).

## 2. One-time setup (from scratch)

### 2.1 Generate a deploy key

```bash
ssh-keygen -t ed25519 -f beamup_deploy_key -N "" -C "beamup-deploy"
```

You now have `beamup_deploy_key` (private) and `beamup_deploy_key.pub` (public).

### 2.2 Add the public key to your GitHub account

1. Open https://github.com/settings/ssh/new
2. Title: `beamup-deploy`
3. Paste the contents of `beamup_deploy_key.pub`
4. **Add SSH key**

### 2.3 Register the key on BeamUp

The host must re-sync your GitHub keys. Either:

- run the official CLI once: `npm install -g beamup-cli && beamup config` (it
  asks for host `a.baby-beamup.club` and your GitHub username), or
- ask the agent — it connects with BeamUp's shared deployer key and runs
  `sync-github-keys <username>` for you.

### 2.4 Set the GitHub secrets

Repo → **Settings → Secrets and variables → Actions** → **New repository
secret**:

| Name                  | Value                                                                           |
| --------------------- | ------------------------------------------------------------------------------- |
| `BEAMUP_SSH_KEY`      | the **private** key (`beamup_deploy_key`, full block incl. `BEGIN`/`END` lines) |
| `BEAMUP_APP_ID`       | the app id — first 12 chars of `sha256("<username>\n")`, e.g. `05ce03aaa76c`    |
| `BEAMUP_PROJECT_NAME` | the app name, e.g. `plugin-host`                                                |

> The workflow reads all three from **secrets** (not variables) — that's a
> deliberate choice; don't move them.

### 2.5 First deploy

Push to `main` (or use the **Actions → Deploy to BeamUp → Run workflow**
button). The workflow:

1. 🔑 normalizes the SSH key (fixes pasted-key corruption) and verifies it
2. 🚀 pushes the repo to dokku (`HEAD:master --force`)
3. ✅ waits for healthchecks and prints the app URL

## 3. Deploying

The workflow triggers **only manually** — it does not run on every commit:

```yaml
on:
  workflow_dispatch: # manual "Deploy now" button
```

To deploy: open **Actions → Deploy to BeamUp → Run workflow**. The workflow:

1. 🔑 normalizes the SSH key (fixes pasted-key corruption) and verifies it
2. 🚀 pushes the repo to dokku (`HEAD:master --force`)
3. ✅ waits for healthchecks and prints the app URL

> Want auto-deploy on every push instead? Add `push: { branches: [main] }` back
> to the `on:` block — the rest of the workflow already handles it.

For a general guide on hosting any project on BeamUp (CLI, direct git push, env
vars, logs, troubleshooting), see **[Beamupguide.md](Beamupguide.md)**.

## 4. Manual deploy options

| Method     | Command                                                                     |
| ---------- | --------------------------------------------------------------------------- |
| GitHub UI  | Actions → **Deploy to BeamUp** → **Run workflow**                           |
| beamup CLI | `npm install -g beamup-cli && beamup` (from the repo)                       |
| Direct git | `git push dokku@a.baby-beamup.club:<app-id>/<app-name> HEAD:master --force` |

## 5. Troubleshooting

| Symptom                                     | Cause                                                               | Fix                                                                                             |
| ------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `error in libcrypto` loading key            | pasted key corrupted (literal `\n`, CRLF, missing trailing newline) | re-set `BEAMUP_SSH_KEY` with the raw key block; the workflow now normalizes these automatically |
| `Permission denied (publickey)`             | key not registered on BeamUp                                        | add public key to GitHub account, then re-sync (`sync-github-keys <username>`)                  |
| `shallow update not allowed`                | dokku rejects shallow clones                                        | workflow uses `fetch-depth: 0` — if deploying manually, clone fully                             |
| `No GITHUB_USER_HASHED: unauthorized`       | using the shared deployer key for non-sync commands                 | only `sync-github-keys` is allowed with it                                                      |
| App 404s after deploy                       | wrong `BEAMUP_APP_ID`/`BEAMUP_PROJECT_NAME`                         | app URL is `https://<app-id>-<app-name>.baby-beamup.club/`                                      |
| `BEAMUP_SSH_KEY is not a valid private key` | secret contains garbage                                             | re-set it from `secrets.md`                                                                     |

## 6. Security notes

- **Never commit private keys.** `secrets.md` in this repo contains the deploy
  key only because the repo is private — if it ever goes public, **rotate the
  key** (generate a new pair, re-add public key to GitHub, re-sync, update the
  secret).
- The deploy key only grants push access to your BeamUp app — it can't touch
  your GitHub account.
- Revoke any GitHub tokens you've pasted into chat once setup is done.

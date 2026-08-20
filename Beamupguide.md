# BeamUp Guide — deploy any project from scratch

**BeamUp** is a free platform-as-a-service for hosting **Stremio addons**, built
by the Stremio team. It's based on [Dokku](https://dokku.com) (the same build
system as Heroku), so anything that runs on Heroku buildpacks or in a Dockerfile
runs on BeamUp.

- Host: `a.baby-beamup.club`
- App URL format: `https://<app-id>-<app-name>.baby-beamup.club/`
- Auth: your **GitHub account** (SSH keys are pulled from GitHub, no BeamUp
  account or dashboard needed)

---

## 1. How it works

1. You push your git repo to `dokku@a.baby-beamup.club:<app-id>/<app-name>` (the
   `app-id` is the first 12 chars of `sha256("<github-username>\n")`).
2. The host builds the app with a Heroku buildpack (Node, Python, Ruby, …) or a
   `Dockerfile`, starts it with a `PORT` environment variable, runs
   healthchecks, and serves it at the URL above.
3. **SSH keys are synced from your GitHub account**: the host fetches
   `https://github.com/<username>.keys` and registers those public keys. The
   `beamup` CLI does this sync automatically (`sync-github-keys <username>`).

## 2. Prerequisites

- [Node.js](https://nodejs.org) (only needed for the CLI — the host itself
  supports any language)
- A GitHub account
- An SSH key **added to your GitHub account**
  (https://github.com/settings/ssh/new) — this is the key BeamUp will accept

## 3. Project requirements

| Stack         | What the repo needs                                    |
| ------------- | ------------------------------------------------------ |
| Node.js       | `package.json` (with a `start` script)                 |
| Python        | `requirements.txt` **or** `Procfile`                   |
| Anything else | a `Dockerfile`                                         |
| All           | listen on the `PORT` env var (e.g. `process.env.PORT`) |

## 4. Method A — beamup CLI (easiest, from your machine)

```bash
npm install beamup-cli -g
```

**One-time config** (host + your GitHub username, then it syncs your keys):

```bash
beamup config a.baby-beamup.club YourGithubUsername
```

**Deploy** (run inside your project folder — first run asks for a project name):

```bash
beamup
```

That's it. The CLI creates `beamup.json` in your project (stores the project
name), adds a `beamup` git remote, syncs your GitHub keys, and pushes.

**Update after edits** — just run `beamup` again (or `git push beamup master`).

**Other commands:**

```bash
beamup init <project-name>     # set the project name without deploying
beamup secrets <name> <value>  # add an environment variable
beamup logs                    # stream app logs
beamup delete                  # delete the project (irreversible)
```

## 5. Method B — GitHub Actions (deploy from the repo, no local CLI)

### 5.1 Generate a deploy key

```bash
ssh-keygen -t ed25519 -f beamup_deploy_key -N "" -C "beamup-deploy"
```

### 5.2 Add the public key to GitHub

https://github.com/settings/ssh/new → paste `beamup_deploy_key.pub` → **Add SSH
key**.

### 5.3 Register the key on BeamUp

The host must re-sync your GitHub keys. Either run `beamup config` once, or
connect with BeamUp's shared deployer key:

```bash
ssh dokku@a.baby-beamup.club "sync-github-keys YourGithubUsername"
```

### 5.4 Set GitHub secrets

Repo → **Settings → Secrets and variables → Actions**:

| Secret                | Value                                                                     |
| --------------------- | ------------------------------------------------------------------------- |
| `BEAMUP_SSH_KEY`      | the **private** key (`beamup_deploy_key`, full block incl. `BEGIN`/`END`) |
| `BEAMUP_APP_ID`       | `sha256("<username>\n")` first 12 chars (e.g. `05ce03aaa76c`)             |
| `BEAMUP_PROJECT_NAME` | the app name (e.g. `plugin-host`)                                         |

### 5.5 The workflow

```yaml
name: Deploy to BeamUp
on:
  workflow_dispatch: # manual "Deploy now" button
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # dokku rejects shallow pushes
      - name: Setup SSH key
        env:
          SSH_KEY: ${{ secrets.BEAMUP_SSH_KEY }}
        run: |
          mkdir -p ~/.ssh
          printf '%s' "$SSH_KEY" | tr -d '\r' | sed -e 's/^"//' -e 's/"$//' \
            | sed 's/\\n/\n/g' > ~/.ssh/id_ed25519
          printf '\n' >> ~/.ssh/id_ed25519   # OpenSSH needs trailing newline
          chmod 600 ~/.ssh/id_ed25519
          ssh-keygen -y -f ~/.ssh/id_ed25519 >/dev/null 2>&1 || { echo "::error::invalid BEAMUP_SSH_KEY"; exit 1; }
          ssh-keyscan a.baby-beamup.club >> ~/.ssh/known_hosts 2>/dev/null || true
      - name: Deploy
        run: |
          git remote add beamup "dokku@a.baby-beamup.club:${{ secrets.BEAMUP_APP_ID }}/${{ secrets.BEAMUP_PROJECT_NAME }}"
          GIT_SSH_COMMAND="ssh -i ~/.ssh/id_ed25519 -o IdentitiesOnly=yes" \
            git push beamup HEAD:master --force
```

Deploy by clicking **Actions → Deploy to BeamUp → Run workflow**.

## 6. Method C — direct git push

```bash
git remote add beamup dokku@a.baby-beamup.club:<app-id>/<app-name>
git push beamup HEAD:master --force
```

Requires a private key whose public half is on your GitHub account **and**
synced to BeamUp (see 5.3).

## 7. Environment variables & logs

- CLI: `beamup secrets NAME value`
- Direct:
  `ssh dokku@a.baby-beamup.club config:set <app-id>/<app-name> NAME=value`
- Logs: `beamup logs` or `ssh dokku@a.baby-beamup.club logs <app-id>-<app-name>`

## 8. Troubleshooting

| Symptom                                                   | Cause / fix                                                                                                                                 |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `error in libcrypto` loading key                          | pasted key corrupted (literal `\n`, CRLF, missing trailing newline). Re-set the secret with the raw block; the workflow above normalizes it |
| `Permission denied (publickey)`                           | key not registered on BeamUp → add public key to GitHub, then `sync-github-keys <username>`                                                 |
| `access denied` / `Could not read from remote repository` | old duplicate-key-hash issue → run `beamup config a.baby-beamup.club <username>` again, then retry                                          |
| `shallow update not allowed`                              | dokku rejects shallow clones → use `fetch-depth: 0` in Actions, or a full clone                                                             |
| `No GITHUB_USER_HASHED: unauthorized`                     | the shared deployer key only allows `sync-github-keys`                                                                                      |
| Same repo deployed twice                                  | BeamUp tracks git history — `git remote rm beamup`, delete `beamup.json`, redeploy under a new name (or `beamup delete` first)              |
| Can't rename a project                                    | not supported — delete and redeploy                                                                                                         |
| App 404s                                                  | wrong `BEAMUP_APP_ID`/`BEAMUP_PROJECT_NAME`; URL is `https://<app-id>-<app-name>.baby-beamup.club/`                                         |

## 9. Limitations

- **Stremio addons only** — the host runs addon-specific checks and caching
  (it's not a general-purpose PaaS).
- **No custom NGINX config** (dokku feature not exposed).
- Only the **Herokuish buildpack** is supported; a Dockerfile-based project
  works via a workaround (include `docker` in the project name).
- No project renaming; one deployment per git history.

## 10. FAQ

- **Is it free?** Yes — BeamUp is a community service by the Stremio team.
- **Do I need a BeamUp account?** No — GitHub authentication only.
- **Can I deploy the same repo twice?** Not recommended; see troubleshooting.
- **How do I update?** Re-run `beamup`, `git push beamup master`, or the Actions
  button — the host rebuilds and redeploys with zero downtime.

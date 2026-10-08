# cleanup-repos

Automatically archives inactive repositories in the `hmcts` GitHub organisation.

The script runs weekly via the [`auto-archive-inactive-repos` workflow](../.github/workflows/auto-archive.yml).

## Policy

| Stage | Inactivity | Action |
|-------|------------|--------|
| Pre-archive warning | 700–729 days (~30 days before archive) | Slack alert to `#cloud-native-announce` |
| Auto-archive | 730+ days (~2 years) | Repository is archived |

Inactivity is measured from the **last non-bot commit** on the default branch.

- Human pushes and merges reset the countdown
- **Renovate**, **Dependabot**, and other `[bot]` commits are ignored
- If no human commit is found, the script falls back to `pushedAt`, then `updatedAt`

## Excluding a repository

### Self-service: GitHub topic (recommended)

Add **one** topic using today's date:

```
no-auto-archive-reviewed-2026-07-14
```

In GitHub:

1. Open the repository in the `hmcts` organisation
2. Click the **gear icon** next to **About** on the repository home page
3. Under **Topics**, add `no-auto-archive-reviewed-YYYY-MM-DD` (use today's date)
4. Save changes

The repository will be skipped on the next weekly run.

### Exclusion re-review (every 700 days)

Topic exclusions are not permanent without renewal.

| State | Slack |
|-------|--------|
| No `no-auto-archive-reviewed-*` topic | Not excluded |
| Topic date is **700+ days** old | Warn: replace with `no-auto-archive-reviewed-(today)` |

Example:

1. Warning posted on **2026-07-14** → set topic to `no-auto-archive-reviewed-2026-07-14`
2. Quiet until **~2028-06-15** (700 days later)
3. Warning again → remove the old topic and add `no-auto-archive-reviewed-2028-06-15`

Keep only **one** `no-auto-archive-reviewed-*` topic on the repository.

### Platform Ops: YAML exclusions

Repositories that must always be excluded can also be listed in [`exclusions.yml`](exclusions.yml). Changes require a PR to this repository and are reviewed by Platform Operations.

Use this for shared platform repositories or cases where a team cannot manage repository topics themselves. YAML exclusions are not covered by the topic review Slack cycle.

## Slack notifications

On scheduled apply runs, alerts are posted to `#cloud-native-announce`:

- **YAML exclusions** — repositories permanently excluded via `exclusions.yml`
- **Topic exclusions** — repositories with a `no-auto-archive-reviewed-*` topic
- **Pre-archive warning** — repositories in the 700–729 day human-inactivity window
- **Exclusion review** — topic-excluded repos due for renewal (≥700 days since topic date)
- **Post-archive summary** — repositories archived that run, plus any failures

## Workflow behaviour

| Trigger | Mode | Archives repos? |
|---------|------|-----------------|
| Weekly schedule (Monday 10:00 UTC) | Apply | Yes |
| Pull request | Dry-run | No |
| Push to `cleanup-repos/**` | Dry-run | No |

Dry-run runs print which repositories would be warned or archived without making changes (Slack only on apply).

If any archive operation fails during an apply run, the workflow fails and a Slack alert includes the failures.

## Local development

```bash
cd cleanup-repos
npm ci
export GITHUB_OAUTH=<github-management-api-token>
npm run cleanup        # dry-run
npm run cleanup:apply  # apply (archives repositories)
```

Optional environment variables for apply mode:

| Variable | Purpose |
|----------|---------|
| `SLACK_WEBHOOK_URL` | Slack incoming webhook for alerts |
| `PRE_ARCHIVE_SLACK_CHANNEL` | Target channel (default: `#cloud-native-announce`) |

## Files

| File | Purpose |
|------|---------|
| `index.js` | Main cleanup script |
| `exclusions.yml` | Permanent exclusion list |
| `package.json` | Node dependencies and npm scripts |

# cleanup-repos

Automatically archives inactive repositories in the `hmcts` GitHub organisation.

The script runs weekly via the [`auto-archive-inactive-repos` workflow](../.github/workflows/auto-archive.yml).

## Policy

| Stage | Inactivity | Action |
|-------|------------|--------|
| Pre-archive warning | 100–103 weeks (~30 days before archive) | Slack alert to `#cloud-native-announce` |
| Auto-archive | 104+ weeks (~2 years) | Repository is archived |

Inactivity is measured from a repository's GitHub `updatedAt` timestamp. Any repository activity — commits, pull requests, issues, releases, or settings changes — resets the countdown.

## Excluding a repository

### Self-service: GitHub topic (recommended)

Teams can exclude a repository without raising a Platform Ops PR by adding the topic:

```
no-auto-archive
```

In GitHub:

1. Open the repository in the `hmcts` organisation
2. Click the **gear icon** next to **About** on the repository home page
3. Under **Topics**, add `no-auto-archive`
4. Save changes

The repository will be skipped on the next weekly run.

### Platform Ops: YAML exclusions

Repositories that must always be excluded can also be listed in [`exclusions.yml`](exclusions.yml). Changes require a PR to this repository and are reviewed by Platform Operations.

Use this for shared platform repositories or cases where a team cannot manage repository topics themselves.

## Slack notifications

On scheduled apply runs, alerts are posted to `#cloud-native-announce`:

- **Pre-archive warning** — repositories entering the 100–103 week window
- **Post-archive summary** — repositories archived that run, plus any failures

## Workflow behaviour

| Trigger | Mode | Archives repos? |
|---------|------|-----------------|
| Weekly schedule (Monday 10:00 UTC) | Apply | Yes |
| Pull request | Dry-run | No |
| Push to `cleanup-repos/**` | Dry-run | No |

Dry-run runs print which repositories would be warned or archived without making changes.

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
| `exclusions.yml` | Platform-managed permanent exclusions |
| `package.json` | Node.js dependencies and npm scripts |

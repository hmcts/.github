#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const { graphql } = require("@octokit/graphql");
const { Octokit } = require("@octokit/rest");
const { differenceInCalendarISOWeeks, parseISO, formatDuration, intervalToDuration } = require("date-fns");
const yaml = require("yaml");

const auth = process.env.GITHUB_OAUTH;

if (!auth) {
    console.error("GITHUB_OAUTH not set. Exiting.");
    process.exit(1);
}

const octokit = new Octokit({
    auth,
    userAgent: "hmcts-github-management",
});

const args = process.argv.slice(2);
const applyMode = args.includes("apply");
const dryRun = !applyMode;
const ARCHIVE_THRESHOLD_WEEKS = 104;
const WARNING_THRESHOLD_WEEKS = 100;
const NO_AUTO_ARCHIVE_TOPIC = "no-auto-archive";
const ARCHIVE_DELAY_MS = 500;
const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL;
const preArchiveSlackChannel = process.env.PRE_ARCHIVE_SLACK_CHANNEL || "#cloud-native-announce";

function loadYamlExclusions() {
    const exclusionsPath = path.join(__dirname, "exclusions.yml");
    const content = fs.readFileSync(exclusionsPath, "utf8");
    const config = yaml.parse(content);

    if (!Array.isArray(config?.repositories)) {
        throw new Error("exclusions.yml must define a 'repositories' array");
    }

    return new Set(config.repositories);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeError(err) {
    const status = err?.status ? `status ${err.status}` : "unknown status";
    const message = err?.message || err?.response?.data?.message || "unknown error";
    return `${status}: ${message}`;
}

function getRetryAfterMs(err) {
    const headers = err?.response?.headers || {};
    const retryAfter = headers["retry-after"] || headers.retry_after;

    if (retryAfter) {
        const seconds = Number(retryAfter);
        if (!Number.isNaN(seconds)) {
            return seconds * 1000;
        }

        const retryDate = Date.parse(retryAfter);
        if (!Number.isNaN(retryDate)) {
            return Math.max(retryDate - Date.now(), 0);
        }
    }

    const reset = headers["x-ratelimit-reset"];
    if (reset) {
        const resetMs = Number(reset) * 1000;
        if (!Number.isNaN(resetMs)) {
            return Math.max(resetMs - Date.now(), 1000);
        }
    }

    return null;
}

function isRateLimitError(err) {
    if (err?.status === 403) {
        const remaining = err?.response?.headers?.["x-ratelimit-remaining"];
        if (remaining === "0") {
            return true;
        }

        const message = `${err?.message || ""} ${err?.response?.data?.message || ""}`.toLowerCase();
        if (message.includes("rate limit") || message.includes("secondary rate limit")) {
            return true;
        }
    }

    if (Array.isArray(err?.errors)) {
        return err.errors.some((error) => error.type === "RATE_LIMITED");
    }

    return false;
}

function isRetriableError(err) {
    const status = err?.status;
    if ([502, 503, 504].includes(status)) {
        return true;
    }

    return isRateLimitError(err);
}

async function withRetry(fn, { retries = 3, delayMs = 2000 } = {}) {
    let attempt = 0;

    while (true) {
        try {
            return await fn();
        } catch (err) {
            attempt++;

            if (!isRetriableError(err) || attempt > retries) {
                throw err;
            }

            const retryAfterMs = getRetryAfterMs(err);
            const waitMs = retryAfterMs ?? delayMs * attempt;

            console.warn(
                `Request failed (${describeError(err)}). Retrying ${attempt}/${retries} in ${waitMs}ms...`
            );

            await sleep(waitMs);
        }
    }
}

async function getRepositories(cursor) {
    return graphql(
        `
        query ($cursor: String) {
          organization(login: "hmcts") {
            repositories(first: 100, after: $cursor, isArchived: false) {
              nodes {
                name
                id
                updatedAt
                repositoryTopics(first: 20) {
                  nodes {
                    topic {
                      name
                    }
                  }
                }
              }
              pageInfo {
                endCursor
                hasNextPage
              }
            }
          }
        }
        `,
        {
            cursor,
            headers: {
                authorization: `token ${auth}`,
            },
            request: {
                timeout: 10000,
            },
        }
    );
}

async function run() {
    console.log("Cleanup script started");
    const results = [];
    const start = new Date();

    let cursor = null;
    let hasNext = true;

    while (hasNext) {
        const pagedResult = await withRetry(
            () => getRepositories(cursor),
            { retries: 3, delayMs: 2000 }
        );

        const nodes = pagedResult?.organization?.repositories?.nodes || [];
        results.push(...nodes);

        const pageInfo = pagedResult?.organization?.repositories?.pageInfo;
        cursor = pageInfo?.endCursor || null;
        hasNext = pageInfo?.hasNextPage || false;
    }

    console.log(`Discovered ${results.length} non-archived repositories`);
    console.log(
        "Completed in: ",
        formatDuration(intervalToDuration({ start, end: new Date() }))
    );

    return results;
}

function caseInsensitiveStringSort(a, b) {
    const nameA = a.toUpperCase();
    const nameB = b.toUpperCase();
    return nameA < nameB ? -1 : nameA > nameB ? 1 : 0;
}

function formatDate(dateString) {
    return new Date(dateString).toISOString().split("T")[0];
}

function getInactiveWeeks(repo) {
    return differenceInCalendarISOWeeks(new Date(), parseISO(repo.updatedAt));
}

function hasExclusionTopic(repo) {
    const topics = repo.repositoryTopics?.nodes || [];
    return topics.some((entry) => entry?.topic?.name === NO_AUTO_ARCHIVE_TOPIC);
}

function buildPreArchiveAlertMessage(repositoriesToWarn) {
    const header = [
        `:warning: *${repositoriesToWarn.length} repositories are due for auto-archive in ~30 days*`,
        `Target channel: ${preArchiveSlackChannel}`,
        "",
        "*Repositories:*",
    ];

    const repositoryLines = repositoriesToWarn.map((repo) => {
        const inactiveWeeks = getInactiveWeeks(repo);
        return `- \`hmcts/${repo.name}\` - last updated: ${formatDate(repo.updatedAt)} (${inactiveWeeks} weeks inactive)`;
    });

    const guidance = [
        "",
        "*How to prevent archiving*",
        `1. Self-service: add the GitHub topic \`${NO_AUTO_ARCHIVE_TOPIC}\` to the repository.`,
        "2. Permanent exclusion: ask Platform Ops to add the repository to `cleanup-repos/exclusions.yml`.",
        "3. Reset inactivity timer: any repository activity (commit, issue, PR, etc.) updates GitHub `updatedAt` and resets the archive countdown.",
    ];

    return [...header, ...repositoryLines, ...guidance].join("\n");
}

function buildPostArchiveAlertMessage(archivedRepos, failedRepos) {
    const lines = [];

    if (archivedRepos.length > 0) {
        lines.push(
            `:package: *Auto-archived ${archivedRepos.length} inactive repositories*`,
            "",
            "*Archived repositories:*"
        );
        archivedRepos
            .slice()
            .sort(caseInsensitiveStringSort)
            .forEach((repositoryName) => lines.push(`- \`hmcts/${repositoryName}\``));
    }

    if (failedRepos.length > 0) {
        if (lines.length > 0) {
            lines.push("");
        }

        lines.push(
            `:x: *Failed to archive ${failedRepos.length} repositories*`,
            "",
            "*Failures:*"
        );
        failedRepos.forEach(({ name, error }) => lines.push(`- \`hmcts/${name}\` - ${error}`));
    }

    return lines.join("\n");
}

async function sendSlackAlert(text) {
    if (!applyMode) {
        return;
    }

    if (!slackWebhookUrl) {
        console.warn("SLACK_WEBHOOK_URL not set. Skipping Slack alert.");
        return;
    }

    const payload = {
        channel: preArchiveSlackChannel,
        text,
    };

    const response = await fetch(slackWebhookUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        const responseBody = await response.text();
        throw new Error(`Slack notification failed (${response.status}): ${responseBody}`);
    }
}

async function archiveRepository(repo) {
    await withRetry(
        () =>
            octokit.rest.repos.update({
                owner: "hmcts",
                repo: repo.name,
                archived: true,
            }),
        { retries: 3, delayMs: 2000 }
    );
}

run()
    .then(async (results) => {
        const yamlExclusions = loadYamlExclusions();
        const excludedByYaml = [];
        const excludedByTopic = [];

        const candidateRepositories = results
            .filter((repo) => {
                if (!repo?.name) {
                    return false;
                }

                if (yamlExclusions.has(repo.name)) {
                    excludedByYaml.push(repo.name);
                    return false;
                }

                if (hasExclusionTopic(repo)) {
                    excludedByTopic.push(repo.name);
                    return false;
                }

                return true;
            })
            .sort((a, b) => caseInsensitiveStringSort(a.name, b.name));

        console.log(`Excluded ${excludedByYaml.length} repositories via exclusions.yml`);
        console.log(`Excluded ${excludedByTopic.length} repositories via ${NO_AUTO_ARCHIVE_TOPIC} topic`);

        const repositoriesToWarn = candidateRepositories.filter((repo) => {
            const inactiveWeeks = getInactiveWeeks(repo);
            return inactiveWeeks >= WARNING_THRESHOLD_WEEKS && inactiveWeeks < ARCHIVE_THRESHOLD_WEEKS;
        });

        const repositoriesToArchive = candidateRepositories.filter((repo) => {
            const inactiveWeeks = getInactiveWeeks(repo);
            return inactiveWeeks >= ARCHIVE_THRESHOLD_WEEKS;
        });

        if (repositoriesToWarn.length > 0) {
            const warningPreview = repositoriesToWarn.map((repo) => ({
                repository: repo.name,
                updatedAt: repo.updatedAt,
                inactiveWeeks: getInactiveWeeks(repo),
                status: "Pre-archive warning (~30 days)",
            }));

            console.log("\nRepositories approaching auto-archive threshold:\n");
            console.table(warningPreview);
        } else {
            console.log("\nNo repositories in pre-archive warning window this run.");
        }

        if (repositoriesToWarn.length > 0) {
            await sendSlackAlert(buildPreArchiveAlertMessage(repositoriesToWarn));
        }

        let archivedRepos = [];
        let failedRepos = [];

        if (repositoriesToArchive.length > 0) {
            const preview = repositoriesToArchive.map((repo) => ({
                repository: repo.name,
                updatedAt: repo.updatedAt,
                inactiveWeeks: getInactiveWeeks(repo),
            }));

            if (dryRun) {
                console.log("\nREAD-ONLY PREVIEW MODE: no repositories will be archived.\n");
            } else {
                console.log("\nAPPLY MODE: the following repositories will be archived.\n");
            }

            console.table(preview);

            if (applyMode) {
                console.log("\nArchiving repositories...\n");

                for (const repo of repositoriesToArchive) {
                    try {
                        await archiveRepository(repo);
                        archivedRepos.push(repo.name);
                        console.log(`Archived ${repo.name}`);
                    } catch (err) {
                        failedRepos.push({ name: repo.name, error: err.message });
                        console.error(`Failed to archive ${repo.name}:`, err.message);
                    }

                    await sleep(ARCHIVE_DELAY_MS);
                }

                console.log(`\nArchived ${archivedRepos.length} repositories this run.`);

                if (archivedRepos.length > 0) {
                    console.log("Repositories archived:");
                    archivedRepos
                        .slice()
                        .sort(caseInsensitiveStringSort)
                        .forEach((repositoryName) => console.log(`- ${repositoryName}`));
                }

                if (failedRepos.length > 0) {
                    console.error(`\nFailed to archive ${failedRepos.length} repositories this run.`);
                    failedRepos.forEach(({ name, error }) => console.error(`- ${name}: ${error}`));
                }

                if (archivedRepos.length > 0 || failedRepos.length > 0) {
                    await sendSlackAlert(buildPostArchiveAlertMessage(archivedRepos, failedRepos));
                }
            }
        } else {
            console.log("\nNo repositories to archive this run.");
        }

        if (failedRepos.length > 0) {
            process.exit(1);
        }
    })
    .catch((err) => {
        console.error("Cleanup failed:", err);
        process.exit(1);
    });

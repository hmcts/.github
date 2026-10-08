#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const { graphql } = require("@octokit/graphql");
const { Octokit } = require("@octokit/rest");
const {
    differenceInCalendarDays,
    parseISO,
    formatDuration,
    intervalToDuration,
    format,
} = require("date-fns");
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
// ~2 years of human inactivity to archive; warn ~30 days beforehand
const ARCHIVE_THRESHOLD_DAYS = 730;
const WARNING_THRESHOLD_DAYS = 700;
const EXCLUSION_REVIEW_INTERVAL_DAYS = 700;
const EXCLUSION_TOPIC_PREFIX = "no-auto-archive-reviewed-";
const EXCLUSION_TOPIC_PATTERN = /^no-auto-archive-reviewed-(\d{4}-\d{2}-\d{2})$/;
const ARCHIVE_DELAY_MS = 500;
const HISTORY_PAGE_SIZE = 50;
const MAX_HISTORY_PAGES = 20;
const ACTIVITY_CONCURRENCY = 5;
const BOT_LOGINS = new Set([
    "renovate[bot]",
    "renovate-bot",
    "dependabot[bot]",
    "dependabot-preview[bot]",
    "github-actions[bot]",
    "hmcts-jenkins",
    "hmcts-platform-operations",
]);
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

/** Run async work over items with at most `concurrency` in flight at once. */
async function mapPool(items, concurrency, fn) {
    const results = new Array(items.length);
    let nextIndex = 0;

    async function worker() {
        while (true) {
            const current = nextIndex;
            nextIndex += 1;

            if (current >= items.length) {
                return;
            }

            results[current] = await fn(items[current], current);
        }
    }

    const workerCount = Math.min(concurrency, items.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return results;
}

function describeError(err) {
    const status = err?.status ? `status ${err.status}` : "unknown status";
    const message = err?.message || err?.response?.data?.message || "unknown error";
    return `${status}: ${message}`;
}

function getRetryAfterMs(err) {
    const headers = err?.headers || err?.response?.headers || {};
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

    const reset = headers["x-ratelimit-reset"] || headers["X-RateLimit-Reset"];
    if (reset) {
        const resetMs = Number(reset) * 1000;
        if (!Number.isNaN(resetMs)) {
            // Cap wait at 55 minutes so a weekly job can recover within the 60m timeout
            return Math.min(Math.max(resetMs - Date.now(), 1000), 55 * 60 * 1000);
        }
    }

    return null;
}

function isRateLimitError(err) {
    const headers = err?.headers || err?.response?.headers || {};
    const remaining = headers["x-ratelimit-remaining"] ?? headers["X-RateLimit-Remaining"];
    if (remaining === "0" || remaining === 0) {
        return true;
    }

    if (err?.status === 403) {
        const message = `${err?.message || ""} ${err?.response?.data?.message || ""}`.toLowerCase();
        if (message.includes("rate limit") || message.includes("secondary rate limit")) {
            return true;
        }
    }

    const message = `${err?.message || ""}`.toLowerCase();
    if (message.includes("rate limit already exceeded") || message.includes("api rate limit")) {
        return true;
    }

    if (Array.isArray(err?.errors)) {
        return err.errors.some((error) => {
            const type = `${error.type || ""}`.toUpperCase();
            const code = `${error.code || ""}`.toLowerCase();
            return (
                type === "RATE_LIMITED" ||
                type === "RATE_LIMIT" ||
                code === "graphql_rate_limit" ||
                `${error.message || ""}`.toLowerCase().includes("rate limit")
            );
        });
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

            const rateLimited = isRateLimitError(err);
            const maxAttempts = rateLimited ? Math.max(retries, 8) : retries;

            if (!isRetriableError(err) || attempt > maxAttempts) {
                throw err;
            }

            const retryAfterMs = getRetryAfterMs(err);
            const waitMs = retryAfterMs ?? delayMs * attempt;

            console.warn(
                `Request failed (${describeError(err)}). Retrying ${attempt}/${maxAttempts} in ${Math.ceil(waitMs / 1000)}s...`
            );

            await sleep(waitMs);
        }
    }
}

function graphqlHeaders() {
    return {
        authorization: `token ${auth}`,
    };
}

async function getOrganizationInventory() {
    const result = await graphql(
        `
        query {
          organization(login: "hmcts") {
            all: repositories {
              totalCount
            }
            archived: repositories(isArchived: true) {
              totalCount
            }
            active: repositories(isArchived: false) {
              totalCount
            }
          }
        }
        `,
        {
            headers: graphqlHeaders(),
            request: {
                timeout: 10000,
            },
        }
    );

    const org = result?.organization;
    return {
        orgTotal: org?.all?.totalCount ?? 0,
        alreadyArchived: org?.archived?.totalCount ?? 0,
        discoveredActive: org?.active?.totalCount ?? 0,
    };
}

function printRepositoryInventory(inventory, extras = {}) {
    console.log("\nRepository inventory:");
    console.table([
        {
            orgTotal: inventory.orgTotal,
            alreadyArchived: inventory.alreadyArchived,
            discoveredActive: inventory.discoveredActive,
            excludedYaml: extras.excludedYaml ?? "-",
            excludedTopic: extras.excludedTopic ?? "-",
            candidates: extras.candidates ?? "-",
            preArchiveWarn: extras.preArchiveWarn ?? "-",
            archiveCandidates: extras.archiveCandidates ?? "-",
            archivedThisRun: extras.archivedThisRun ?? "-",
            failedThisRun: extras.failedThisRun ?? "-",
        },
    ]);
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
                pushedAt
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
            headers: graphqlHeaders(),
            request: {
                timeout: 10000,
            },
        }
    );
}

async function getDefaultBranchHistoryPage(repoName, cursor) {
    return graphql(
        `
        query ($owner: String!, $name: String!, $cursor: String, $pageSize: Int!) {
          repository(owner: $owner, name: $name) {
            defaultBranchRef {
              target {
                ... on Commit {
                  history(first: $pageSize, after: $cursor) {
                    nodes {
                      committedDate
                      author {
                        user {
                          login
                        }
                        name
                      }
                      committer {
                        user {
                          login
                        }
                        name
                      }
                    }
                    pageInfo {
                      endCursor
                      hasNextPage
                    }
                  }
                }
              }
            }
          }
        }
        `,
        {
            owner: "hmcts",
            name: repoName,
            cursor,
            pageSize: HISTORY_PAGE_SIZE,
            headers: graphqlHeaders(),
            request: {
                timeout: 15000,
            },
        }
    );
}

function isBotIdentity(login, name) {
    const normalisedLogin = (login || "").toLowerCase();
    const normalisedName = (name || "").toLowerCase();

    if (normalisedLogin && BOT_LOGINS.has(normalisedLogin)) {
        return true;
    }

    if (normalisedLogin.endsWith("[bot]")) {
        return true;
    }

    if (normalisedLogin.includes("renovate") || normalisedName.includes("renovate")) {
        return true;
    }

    if (normalisedLogin.includes("dependabot") || normalisedName.includes("dependabot")) {
        return true;
    }

    return false;
}

function isBotCommit(commit) {
    const authorLogin = commit?.author?.user?.login;
    const authorName = commit?.author?.name;
    const committerLogin = commit?.committer?.user?.login;
    const committerName = commit?.committer?.name;

    // Count as bot only when both sides look automated (covers merge commits)
    const authorIsBot = isBotIdentity(authorLogin, authorName);
    const committerIsBot = isBotIdentity(committerLogin, committerName);

    if (!authorLogin && !committerLogin) {
        return isBotIdentity(null, authorName) || isBotIdentity(null, committerName);
    }

    return authorIsBot && (committerIsBot || !committerLogin);
}

/**
 * Last meaningful code activity: newest non-bot commit on the default branch.
 * Renovate/Dependabot commits are ignored. Falls back to pushedAt, then updatedAt.
 */
async function resolveLastHumanActivity(repo) {
    let cursor = null;
    let pages = 0;

    while (pages < MAX_HISTORY_PAGES) {
        pages += 1;

        const result = await withRetry(
            () => getDefaultBranchHistoryPage(repo.name, cursor),
            { retries: 3, delayMs: 2000 }
        );

        const history = result?.repository?.defaultBranchRef?.target?.history;
        const nodes = history?.nodes || [];

        if (nodes.length === 0) {
            break;
        }

        for (const commit of nodes) {
            if (!isBotCommit(commit)) {
                return {
                    activityAt: commit.committedDate,
                    source: "human-commit",
                };
            }
        }

        const oldestOnPage = nodes[nodes.length - 1]?.committedDate;
        const pageInfo = history?.pageInfo;

        // All commits on this page are bots. If the oldest is already past the
        // archive threshold, any human commit is at least that old.
        if (
            oldestOnPage &&
            differenceInCalendarDays(new Date(), parseISO(oldestOnPage)) >= ARCHIVE_THRESHOLD_DAYS
        ) {
            return {
                activityAt: oldestOnPage,
                source: "bot-history-bound",
            };
        }

        if (!pageInfo?.hasNextPage) {
            break;
        }

        cursor = pageInfo.endCursor;
    }

    if (repo.pushedAt) {
        return { activityAt: repo.pushedAt, source: "pushedAt-fallback" };
    }

    return { activityAt: repo.updatedAt, source: "updatedAt-fallback" };
}

async function run() {
    console.log("Cleanup script started");

    const inventory = await withRetry(() => getOrganizationInventory(), {
        retries: 3,
        delayMs: 2000,
    });
    printRepositoryInventory(inventory);

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

    console.log(
        `Listed ${results.length} non-archived repositories (GraphQL active count: ${inventory.discoveredActive})`
    );
    console.log(
        "Completed listing in: ",
        formatDuration(intervalToDuration({ start, end: new Date() }))
    );

    return { results, inventory };
}

function caseInsensitiveStringSort(a, b) {
    const nameA = a.toUpperCase();
    const nameB = b.toUpperCase();
    return nameA < nameB ? -1 : nameA > nameB ? 1 : 0;
}

function formatDate(dateString) {
    return new Date(dateString).toISOString().split("T")[0];
}

function todayIsoDate() {
    return format(new Date(), "yyyy-MM-dd");
}

function getTopicNames(repo) {
    return (repo.repositoryTopics?.nodes || [])
        .map((entry) => entry?.topic?.name)
        .filter(Boolean);
}

function exclusionTopicForDate(isoDate) {
    return `${EXCLUSION_TOPIC_PREFIX}${isoDate}`;
}

function getExclusionTopics(repo) {
    return getTopicNames(repo)
        .map((topic) => {
            const match = topic.match(EXCLUSION_TOPIC_PATTERN);
            if (!match) {
                return null;
            }

            const date = parseISO(match[1]);
            if (Number.isNaN(date.getTime())) {
                return null;
            }

            return { topic, date, iso: match[1] };
        })
        .filter(Boolean)
        .sort((a, b) => b.date - a.date);
}

function hasExclusionTopic(repo) {
    return getExclusionTopics(repo).length > 0;
}

function getInactiveDays(repo) {
    return differenceInCalendarDays(new Date(), parseISO(repo.lastHumanActivityAt));
}

function daysUntilArchive(repo) {
    return Math.max(ARCHIVE_THRESHOLD_DAYS - getInactiveDays(repo), 0);
}

function buildSelfServiceTopicsGuidance() {
    return [
        "",
        "*Self-service exclusion (recommended)*",
        "Teams can exclude a repo without a Platform Ops PR by adding one topic:",
        `• \`${exclusionTopicForDate(todayIsoDate())}\` (use today's date; renew every ${EXCLUSION_REVIEW_INTERVAL_DAYS} days when Slack asks)`,
        "In GitHub: repository → gear icon next to About → Topics → add topic → Save.",
    ];
}

function buildYamlExclusionsAlertMessage(excludedRepos) {
    const sorted = excludedRepos.slice().sort(caseInsensitiveStringSort);
    const header = [
        `:no_entry_sign: *Repos already excluded via exclusions.yml* (${sorted.length})`,
        `Target channel: ${preArchiveSlackChannel}`,
        "",
        "These are permanently excluded from auto-archive (Platform Ops list):",
    ];

    const repositoryLines = sorted.map((name) => `- \`hmcts/${name}\``);

    return [...header, ...repositoryLines, ...buildSelfServiceTopicsGuidance()].join("\n");
}

function buildTopicExclusionsAlertMessage(topicExcludedRepos) {
    const sorted = topicExcludedRepos
        .slice()
        .sort((a, b) => caseInsensitiveStringSort(a.name, b.name));

    const header = [
        `:label: *Repos already excluded via \`${EXCLUSION_TOPIC_PREFIX}*\` topic* (${sorted.length})`,
        `Target channel: ${preArchiveSlackChannel}`,
        "",
        "These are self-service exclusions (teams added the topic):",
    ];

    const repositoryLines = sorted.map((repo) => {
        const exclusion = getExclusionTopics(repo)[0];
        return `- \`hmcts/${repo.name}\` (\`${exclusion.topic}\`)`;
    });

    return [...header, ...repositoryLines, ...buildSelfServiceTopicsGuidance()].join("\n");
}

function buildPreArchiveAlertMessage(repositoriesToWarn) {
    const header = [
        `:warning: *${repositoriesToWarn.length} repositories are due for auto-archive in ~30 days*`,
        `Target channel: ${preArchiveSlackChannel}`,
        "",
        "*Repositories:*",
    ];

    const repositoryLines = repositoriesToWarn.map((repo) => {
        const inactiveDays = getInactiveDays(repo);
        const daysLeft = daysUntilArchive(repo);
        return `- \`hmcts/${repo.name}\` - last human activity: ${formatDate(repo.lastHumanActivityAt)} (${inactiveDays} days inactive, ~${daysLeft} days until archive; source: ${repo.lastHumanActivitySource})`;
    });

    const guidance = [
        "",
        "*How to prevent archiving*",
        ...buildSelfServiceTopicsGuidance().slice(2),
        "",
        "*Other options*",
        "• Permanent exclusion: ask Platform Ops to add the repository to `cleanup-repos/exclusions.yml`.",
        "• Reset inactivity timer: a non-bot push/commit on the default branch (Renovate/Dependabot are ignored).",
    ];

    return [...header, ...repositoryLines, ...guidance].join("\n");
}

function buildExclusionReviewAlertMessage(repositoriesNeedingReview, warningDate) {
    const renewalTopic = exclusionTopicForDate(warningDate);
    const header = [
        `:hourglass: *${repositoriesNeedingReview.length} repositories need exclusion review*`,
        `Target channel: ${preArchiveSlackChannel}`,
        "",
        `If a repository should remain excluded, replace the old \`${EXCLUSION_TOPIC_PREFIX}*\` topic with \`${renewalTopic}\` (today's warning date).`,
        "",
        "*Repositories:*",
    ];

    const repositoryLines = repositoriesNeedingReview.map((entry) =>
        `- \`hmcts/${entry.repo.name}\` still excluded from archiving — please replace \`${entry.exclusion.topic}\` with \`${renewalTopic}\` (${entry.daysSinceReview} days since last review)`
    );

    return [...header, ...repositoryLines].join("\n");
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

function collectExclusionReviews(topicExcludedRepos) {
    const warningDate = todayIsoDate();
    const needingReview = [];

    for (const repo of topicExcludedRepos) {
        const exclusion = getExclusionTopics(repo)[0];
        const daysSinceReview = differenceInCalendarDays(new Date(), exclusion.date);

        if (daysSinceReview >= EXCLUSION_REVIEW_INTERVAL_DAYS) {
            needingReview.push({
                repo,
                exclusion,
                daysSinceReview,
            });
        }
    }

    return { warningDate, needingReview };
}

run()
    .then(async ({ results, inventory }) => {
        const yamlExclusions = loadYamlExclusions();
        const excludedByYaml = [];
        const topicExcludedRepos = [];
        const candidateRepositories = [];

        for (const repo of results) {
            if (!repo?.name) {
                continue;
            }

            if (yamlExclusions.has(repo.name)) {
                excludedByYaml.push(repo.name);
                continue;
            }

            if (hasExclusionTopic(repo)) {
                topicExcludedRepos.push(repo);
                continue;
            }

            candidateRepositories.push(repo);
        }

        topicExcludedRepos.sort((a, b) => caseInsensitiveStringSort(a.name, b.name));
        candidateRepositories.sort((a, b) => caseInsensitiveStringSort(a.name, b.name));

        console.log(`Excluded ${excludedByYaml.length} repositories via exclusions.yml`);
        if (excludedByYaml.length > 0) {
            console.log("\nRepos already excluded via exclusions.yml:\n");
            console.table(
                excludedByYaml
                    .slice()
                    .sort(caseInsensitiveStringSort)
                    .map((name) => ({ repository: name, source: "exclusions.yml" }))
            );
            await sendSlackAlert(buildYamlExclusionsAlertMessage(excludedByYaml));
        }

        console.log(
            `Excluded ${topicExcludedRepos.length} repositories via ${EXCLUSION_TOPIC_PREFIX}* topic`
        );
        if (topicExcludedRepos.length > 0) {
            console.log(`\nRepos already excluded via ${EXCLUSION_TOPIC_PREFIX}* topic:\n`);
            console.table(
                topicExcludedRepos.map((repo) => {
                    const exclusion = getExclusionTopics(repo)[0];
                    return {
                        repository: repo.name,
                        topic: exclusion.topic,
                        reviewed: exclusion.iso,
                    };
                })
            );
            await sendSlackAlert(buildTopicExclusionsAlertMessage(topicExcludedRepos));
        }

        printRepositoryInventory(inventory, {
            excludedYaml: excludedByYaml.length,
            excludedTopic: topicExcludedRepos.length,
            candidates: candidateRepositories.length,
        });

        const { warningDate, needingReview } = collectExclusionReviews(topicExcludedRepos);

        if (needingReview.length > 0) {
            console.log("\nTopic exclusions needing review:\n");
            console.table(
                needingReview.map((entry) => ({
                    repository: entry.repo.name,
                    currentTopic: entry.exclusion.topic,
                    daysSinceReview: entry.daysSinceReview,
                    replaceWith: exclusionTopicForDate(warningDate),
                }))
            );
            await sendSlackAlert(buildExclusionReviewAlertMessage(needingReview, warningDate));
        } else {
            console.log("\nNo topic-based exclusions need review this run.");
        }

        const candidateCount = candidateRepositories.length;
        const progressEvery = 50;

        console.log(
            `\nResolving last human activity for ${candidateCount} candidate repositories (ignoring Renovate/Dependabot, concurrency ${ACTIVITY_CONCURRENCY})...`
        );
        const activityStart = new Date();
        let checked = 0;

        await mapPool(candidateRepositories, ACTIVITY_CONCURRENCY, async (repo) => {
            const activity = await resolveLastHumanActivity(repo);
            repo.lastHumanActivityAt = activity.activityAt;
            repo.lastHumanActivitySource = activity.source;

            checked += 1;
            const remaining = candidateCount - checked;
            if (checked === candidateCount || checked % progressEvery === 0) {
                console.log(
                    `Resolving last human activity for ${remaining} candidate repositories (ignoring Renovate/Dependabot)... [${checked}/${candidateCount} checked]`
                );
            }
        });

        console.log(
            "Activity resolution completed in: ",
            formatDuration(intervalToDuration({ start: activityStart, end: new Date() }))
        );

        const repositoriesToWarn = candidateRepositories.filter((repo) => {
            const inactiveDays = getInactiveDays(repo);
            return inactiveDays >= WARNING_THRESHOLD_DAYS && inactiveDays < ARCHIVE_THRESHOLD_DAYS;
        });

        const repositoriesToArchive = candidateRepositories.filter((repo) => {
            const inactiveDays = getInactiveDays(repo);
            return inactiveDays >= ARCHIVE_THRESHOLD_DAYS;
        });

        if (repositoriesToWarn.length > 0) {
            const warningPreview = repositoriesToWarn.map((repo) => ({
                repository: repo.name,
                lastHumanActivityAt: repo.lastHumanActivityAt,
                source: repo.lastHumanActivitySource,
                inactiveDays: getInactiveDays(repo),
                daysUntilArchive: daysUntilArchive(repo),
                status: "Pre-archive warning (~30 days)",
            }));

            console.log("\nRepositories approaching auto-archive threshold:\n");
            console.table(warningPreview);
            await sendSlackAlert(buildPreArchiveAlertMessage(repositoriesToWarn));
        } else {
            console.log("\nNo repositories in pre-archive warning window this run.");
        }

        let archivedRepos = [];
        let failedRepos = [];

        if (repositoriesToArchive.length > 0) {
            const preview = repositoriesToArchive.map((repo) => ({
                repository: repo.name,
                lastHumanActivityAt: repo.lastHumanActivityAt,
                source: repo.lastHumanActivitySource,
                inactiveDays: getInactiveDays(repo),
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

        let finalInventory = inventory;
        if (applyMode && archivedRepos.length > 0) {
            finalInventory = await withRetry(() => getOrganizationInventory(), {
                retries: 3,
                delayMs: 2000,
            });
        }

        console.log("\nRun summary:");
        printRepositoryInventory(finalInventory, {
            excludedYaml: excludedByYaml.length,
            excludedTopic: topicExcludedRepos.length,
            candidates: candidateRepositories.length,
            preArchiveWarn: repositoriesToWarn.length,
            archiveCandidates: repositoriesToArchive.length,
            archivedThisRun: applyMode ? archivedRepos.length : 0,
            failedThisRun: failedRepos.length,
        });

        if (failedRepos.length > 0) {
            process.exit(1);
        }
    })
    .catch((err) => {
        console.error("Cleanup failed:", err);
        process.exit(1);
    });

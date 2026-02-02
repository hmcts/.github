#!/usr/bin/env node

const { graphql } = require("@octokit/graphql");
const { Octokit } = require("@octokit/rest");
const { differenceInCalendarISOWeeks, parseISO, formatDuration, intervalToDuration } = require("date-fns");

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
const dryRun = args[0] !== "apply";

const EXCLUSION_LIST = [
    "ccd-case-migration-template",
    "chart-ccd-elasticsearch",
    "chart-idam-preview",
    "cnp-java-base",
    "cnp-module-action-group",
    "cnp-module-metric-alert",
    "cnp-module-api-mgmt-api",
    "cnp-module-api-mgmt-api-policy",
    "cnp-module-api-mgmt-product",
    "cnp-plum-batch",
    "idam-docker-utils",
    "one-per-page",
    "security-test-rules",
    "sscs-case-creator",
    "ethos-repl-migration-caseloader",
    "ccd-docker-user-profile-importer",
    "rdo-ssl-creation",
    "div-test-harness",
    "vh-core-infra",
    "vh-monitoring",
    "probatemandb",
    "terraform-module-servicebus-subscription",
    "terraform-module-servicebus-queue",
    "chart-function",
    "cnp-artifactory-init",
    "cnp-node-base",
    "sandbox-auto-cleardown",
    "dtspo-orphan-resources-cleanup",
    "auto-shutdown",
];

function last(array) {
    return array[array.length - 1];
}

async function withRetry(fn, { retries = 3, delayMs = 2000 } = {}) {
    let attempt = 0;

    while (true) {
        try {
            return await fn();
        } catch (err) {
            attempt++;

            const status = err?.status;
            const retriable = [502, 503, 504].includes(status);

            if (!retriable || attempt > retries) {
                throw err;
            }

            console.warn(
                `Request failed (status ${status}). Retrying ${attempt}/${retries} in ${delayMs}ms...`
            );

            await new Promise((res) => setTimeout(res, delayMs));
        }
    }
}

async function getRepositories(cursor) {
    return graphql(
        `
        query ($cursor: String) {
          search(
            first: 100
            after: $cursor
            type: REPOSITORY
            query: "user:hmcts archived:false"
          ) {
            edges {
              node {
                ... on Repository {
                  name
                  id
                  updatedAt
                }
              }
              cursor
            }
            repositoryCount
            pageInfo {
              endCursor
              hasNextPage
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

        const edges = (pagedResult?.search?.edges) || [];
        results.push(...edges);

        const pageInfo = pagedResult?.search?.pageInfo;
        cursor = pageInfo?.endCursor || null;
        hasNext = pageInfo?.hasNextPage || false;
    }

    console.log(
        "Completed in: ",
        formatDuration(intervalToDuration({ start, end: new Date() }))
    );

    return results;
}

function caseInsensitiveStringSort() {
    return (a, b) => {
        const nameA = a.toUpperCase();
        const nameB = b.toUpperCase();
        return nameA < nameB ? -1 : nameA > nameB ? 1 : 0;
    };
}

run()
    .then(async (results) => {
        const repositoriesToArchive = results
            .filter(
                (result) =>
                    result?.node &&
                    !EXCLUSION_LIST.includes(result.node.name) &&
                    differenceInCalendarISOWeeks(new Date(), parseISO(result.node.updatedAt)) > 104
            )
            .map((repo) => repo.node)
            .sort((a, b) => caseInsensitiveStringSort()(a.name, b.name));

        if (repositoriesToArchive.length > 0) {
            console.log("\nWould archive the following repositories:\n");
            repositoriesToArchive.forEach((repo) => {
                console.log(repo.name);
            });
            if (!dryRun) {
                console.log("\nArchiving repositories...\n");
                for (const repo of repositoriesToArchive) {
                    try {
                        await octokit.rest.repos.update({
                            owner: "hmcts",
                            repo: repo.name,
                            archived: true,
                        });
                        console.log(`Archived ${repo.name}`);
                    } catch (err) {
                        console.error(`Failed to archive ${repo.name}:`, err.message);
                    }
                }
            }
        } else {
            console.log("\nNo repositories to archive this run.")
        }
    })
    .catch((err) => {
        console.error("Cleanup failed:", err);
        process.exit(1);
    });

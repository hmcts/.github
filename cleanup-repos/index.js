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
    "sandbox-aut-cleardown",
    "dtspo-orphan-resources-cleanup",
    "auto-shutdown",
];

function last(array) {
    return array[array.length - 1];
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
                refs(refPrefix: "refs/heads/") {
                  totalCount
                }
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
        }
    );
}

async function run() {
    const results = [];
    const start = new Date();

    let cursor = null;
    let hasNext = true;

    while (hasNext) {
        const pagedResult = await getRepositories(cursor);
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
            .map((repo) => repo.node.name)
            .sort(caseInsensitiveStringSort());

        if (repositoriesToArchive.length > 0) {
            console.log(`\nWould archive the following repositories:\n`);
            repositoriesToArchive.forEach((repo) => {
                console.log(repo);
            });
        } else {
            console.log("\nNo repositories to archive this run.");
        }
    })
    .catch(console.error);
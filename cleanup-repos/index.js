#!/usr/bin/env node

const { graphql } = require("@octokit/graphql");
const formatDuration = require('date-fns/formatDuration')
const intervalToDuration = require('date-fns/intervalToDuration')
const differenceInCalendarISOWeeks = require('date-fns/differenceInCalendarISOWeeks')
const parseISO = require('date-fns/parseISO')
const { Octokit } = require("@octokit/rest");

const auth = process.env.GITHUB_OAUTH

const octokit = new Octokit({
    auth: auth,
    userAgent: 'hmcts-github-management',
})

const args = process.argv.slice(2);

let dryRun
if (args.length === 0) {
    dryRun = true
} else if (args[0] === 'apply') {
    dryRun = false
}

const EXCLUSION_LIST = [
    'ccd-case-migration-template',
    'chart-ccd-elasticsearch',
    'chart-idam-preview',
    'cnp-java-base',
    'cnp-module-action-group',
    'cnp-module-metric-alert',
    'cnp-module-api-mgmt-api',
    'cnp-module-api-mgmt-api-policy',
    'cnp-module-api-mgmt-product',
    'cnp-plum-batch',
    'idam-docker-utils',
    'one-per-page',
    'security-test-rules',
    'sscs-case-creator',
    'ethos-repl-migration-caseloader',
    'ccd-docker-user-profile-importer',
    'rdo-ssl-creation',
    'div-test-harness',
    'vh-core-infra',
    'vh-monitoring',
    'probatemandb',
    'terraform-module-servicebus-subscription',
    'terraform-module-servicebus-queue',
    'chart-function',
    'cnp-artifactory-init',
    'cnp-node-base',
    'sandbox-aut-cleardown',
    'dtspo-orphan-resources-cleanup',
    'cnp-java-base',
    'auto-shutdown',
]

function last(array) {
    return array[array.length - 1];
}

async function getRepositories(cursor) {
    return await graphql(`
    query($cursor: String) {
      search(first: 100, after: $cursor, type: REPOSITORY, query: "user:hmcts archived:false") {
        edges {
          node {
            ... on Repository {
              name,
              id, name, updatedAt, refs(refPrefix: "refs/heads/") {
                totalCount
              },
            }
          }
          cursor
        }
        repositoryCount
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
    const results = []
    const start = new Date()

    let cursor = null
    let hasNext = true

    while (hasNext) {
        const pagedResult = await getRepositories(cursor)
        const edges = (pagedResult && pagedResult.search && pagedResult.search.edges) || []
        results.push(...edges)

        const pageInfo = pagedResult && pagedResult.search && pagedResult.search.pageInfo
        cursor = pageInfo && pageInfo.endCursor ? pageInfo.endCursor : null
        hasNext = pageInfo && pageInfo.hasNextPage ? true : false
    }

    console.log('Completed in: ', formatDuration(intervalToDuration({ start: start, end: new Date() })))
    return results
}

function caseInsensitiveStringSort() {
    return (a, b) => {
        const nameA = a.toUpperCase();
        const nameB = b.toUpperCase();
        if (nameA < nameB) {
            return -1;
        }
        if (nameA > nameB) {
            return 1;
        }

        return 0;
    };
}

run()
    .then(results => {
        const repositoriesNotUpdatedLongerThanAYear = results
            .filter(result =>
                result.node.refs.totalCount !== 0 &&
                !EXCLUSION_LIST.includes(result.node.name) &&
                differenceInCalendarISOWeeks(new Date(), parseISO(result.node.updatedAt)) > 52
            )
            .map(repo => repo.node.name)
            .sort(caseInsensitiveStringSort())

        console.log(`In-active repositories: ${repositoriesNotUpdatedLongerThanAYear.length}`)
        console.log()

        repositoriesNotUpdatedLongerThanAYear
            .forEach(repo => {
                console.log(repo); // always log repo name
                if (!dryRun) {
                    octokit.rest.repos.update({
                        owner: 'hmcts',
                        repo,
                        archived: true
                    })
                        .then(res => console.log(`Archived ${res.url}`))
                        .catch(err => console.log(err))
                } else {
                    console.log(`Would archive: ${repo}`);
                }
            })
    })
    .catch(console.log)
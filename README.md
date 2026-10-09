# HMCTS defaults

This repository contains community health files defaults for all repositories within HMCTS:

- GitHub workflows
- Renovate templates

## Contributing

Please read the [contributing guide](./CONTRIBUTING.md)

## Renovate

Global renovate configuration is contained within this repository, use this to implement HMCTS's default renovate configuration in your repository:

| Config file | Description |
|---|---|
| `./renovate-config.json` | Configures the basic renovate settings such as the schedule time and timezone. It also configures helm dependency manager, package rules for `Flyway` and `cnp-jenkins-library` dependencies, and some host matching rules for helm dependencies. |
| `./renovate.json` | One of the default configurations available for use in your repository.  It combines settings in `renovate-config.json` with `automerge-all.json` - this means it will automatically raise PRs and auto-approve them via `renovate-approve` bots, if you have auto-merge enabled in your repository this means dependencies will always get updated automatically with no human review if the pipeline checks have passed.|
| `./renovate/automerge-all.json` | Renovate preset for automatic raising and approving of dependency update PRs, it is not `patch/minor/major` limited and as described above might cause automatic dependency updates **so use wisely**.|
| `./renovate/automerge-minor.json` | Renovate preset for automatic raising and approving of only the `patch` and `minor` version update PRs of the dependencies, this is a safer alternative to `automerge-all.json`.|
| `./renovate/flux.json` | This preset is specific to `hmcts/cnp-flux-config` and `hmcts/sds-flux-config`, used to configure updates of specific dependencies in these repositories.
| `./renovate/global.json` | Deprecated, use ./renovate-config.json instead|
| `./renovate/cnp-jenkins-library.json` | Deprecated. Its configuration has moved to the global `./renovate-config.json` default. |
| `./renovate/cpp-terraform-azurerm-key-vault.json` | This is a Terraform module specific Renovate preset, use it to keep this Terraform up to date within your consuming repository. It will automatically raise and approve PRs (which will be merge if auto-merge is on) for `patch` and `minor` versions, will raise PRs requiring human review for `major` versions.

The base configuration also detects `@Library` declarations in `Jenkinsfile_*` files and updates `hmcts/cnp-jenkins-library` from GitHub tags. Patch and minor releases are set to automerge; major releases require review.

## Local Renovate validation

Use following Make target to validate new Renovate config/preset, this allows you to catch typos and other simple problems before you merge your changes and Renovate scan rolls around which can take a while.  
Note: validation may fail due to suggested config migration but this is not an indication it will not work, it just suggests we should update the configuration to more recent.

```bash
RENOVATE_CONFIG_FILE=<path-to-renovate-file> make renovate
```

## In-depth local testing with dry-run   

> **Note:** Local Renovate Docker image may use a different version or configuration from the hosted service used by our GitHub repositories.
>
> As a result, local runs may show migration warnings that do not appear in the hosted service's logs. Treat dry-run results as a preview, not a guarantee of identical behaviour.

You can investigate potential Renovate behaviour in more depth by using the self-hosted Renovate Docker image with a dry run option instead of just a validation.
You will need following secrets:

- `RENOVATE_REPOSITORY` remote github repository you want your Docker Renovate to perform a dry-run against
- `RENOVATE_CONFIG_FILE` renovate config file you want to test, defaults to [renovate.json](renovate.json)
- `GITHUB_RENOVATE_TOKEN` this can be a PAT token you created in your GitHub account, put this in your `.env` file under `GITHUB_RENOVATE_TOKEN=github_pat_xyz` (if you are working with a private repository the PAT will likely need to be approved into the `hmcts` organisation)
- `RENOVATE_ACR_APPID` when using username/password the convention is to use default `00000000-0000-0000-0000-000000000000`, this is automatically set for you by the script
- `RENOVATE_ACR_SECRET` ACR secret needed by Renovate to authenticate to the `hmctsprod` ACR, this is automatically retrieved for you by the script using `az acr login`

If you are working with a compound renovate config file where you are extending some other config you can create a branch in the upstream repository and extend the branch like so:

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": [
    "local>hmcts/.github:renovate-config",
    "local>hmcts/.github//renovate/flux#your-branch"
  ]
}
```

Use following Make target to see what Renovate is going to do given `x.json` renovate config in `hmcts/y` repository:

```bash
# ensure you have .env with GITHUB_RENOVATE_TOKEN first
make renovate-dry-run # and answer prompts
RENOVATE_REPOSITORY='hmcts/y' RENOVATE_CONFIG_FILE='../x.json' make renovate-dry-run # press enter to skip prompts and use set values
```

Renovate container will be spun up with [`--dry-run=full` option](https://docs.renovatebot.com/self-hosted-configuration/#dryrun) which means Renovate will not actually try to create any PRs or other updates.

Once Renovate run is done Docker container will terminate and you should be able to inspect the debug log in `docker-dry-run.log`.

The log will be quite long so when looking for whether expected updates were performed either search by the version you are expecting or a dependency name, examples:

- `2.585-1187`
- `"depName": "hmctsprod.azurecr.io/jenkins/jenkins"`

It is worth looking through the merged config to confirm whether it was constructed in the way you would expect, example:

```
...
DEBUG: Resolved shallow config, without merging internal presets (repository=hmcts/cnp-flux-config)
       "renovateVersion": "44.18.0",
       "config": {
         "$schema": "https://docs.renovatebot.com/renovate-schema.json",
         "description": ["Onboarding preset for use with HMCTS's repositories"],
         "timezone": "Europe/London",
         "schedule": ["after 7am and before 11am every weekday"],
         "labels": ["dependencies"],
         "helmv3": {
           "managerFilePatterns": ["/\\Chart.yaml$/"],
           "bumpVersion": "patch",
           "registryAliases": {
             "hmctspublic": "oci://hmctspublic.azurecr.io/helm",
             "hmctsprod": "oci://hmctsprod.azurecr.io/helm"
           }
         },
         "packageRules": [
...
```

Most of the time you will be looking for a list of updates to be applied to confirm your dependency is being correctly detected and handled such as:
```
...
         {
           "branchName": "renovate/jenkins-versions",
           "prNo": null,
           "prTitle": "Update Jenkins controller and chart versions",
           "result": "not-scheduled",
           "upgrades": [
             {
               "datasource": "docker",
               "depName": "hmctsprod.azurecr.io/jenkins/jenkins",
               "displayPending": "",
               "fixedVersion": "2.584-1184",
               "currentVersion": "2.584-1184",
               "currentValue": "2.584-1184",
               "newValue": "2.585-1187",
               "newVersion": "2.585-1187",
               "packageFile": "apps/jenkins/jenkins/sbox-intsvc/jenkins-controller-version.yaml",
               "updateType": "minor",
               "packageName": "hmctsprod.azurecr.io/jenkins/jenkins"
             },
             {
               "datasource": "helm",
               "depName": "jenkins",
               "displayPending": "",
               "fixedVersion": "5.9.64",
               "currentVersion": "5.9.64",
               "currentValue": "5.9.64",
               "newValue": "5.9.68",
               "newVersion": "5.9.68",
               "newDigest": "5eba515b2fd7819523251c38927fc96b767feb1c1caab78a1f19312bed70c020",
               "packageFile": "apps/jenkins/jenkins/jenkins.yaml",
               "updateType": "patch",
               "packageName": "jenkins"
             }
           ]
         },
...
```

Here is an example of a version matching conflict you might be able to catch when inspecting the file, here Renovate confused `Jenkins chart` version with a `sidecar chart` version due to lax matching rules:

```
DEBUG: Dependency hmctsprod.azurecr.io/jenkins/jenkins has unsupported/unversioned value 1.30.9 (versioning=regex:^(?<major>\d+)\.(?<minor>\d+)-(?<patch>\d+)$) (repository=hmcts/cnp-flux-config)
```

You can also use Copilot to help you analyse the debug output and verify your configuration will work correctly.

### Adding presets for Terraform modules

Please refer to [this readme](./documentation/adding-presets-for-modules.md) regarding adding Renovate presets for more Terraform modules.
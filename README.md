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
| `./renovate-config.json` | Configures the basic renovate settings such as the schedule time and timezone. It also configures helm dependency manager, package rules for `Flyway` dependency and some host matching rules for helm dependencies. |
| `./renovate.json` | One of the default configurations available for use in your repository.  It combines settings in `renovate-config.json` with `automerge-all.json` - this means it will automatically raise PRs and auto-approve them via `renovate-approve` bots, if you have auto-merge enabled in your repository this means dependencies will always get updated automatically with no human review if the pipeline checks have passed.|
| `./renovate/automerge-all.json` | Renovate preset for automatic raising and approving of dependency update PRs, it is not `patch/minor/major` limited and as described above might cause automatic dependency updates **so use wisely**.|
| `./renovate/automerge-minor.json` | Renovate preset for automatic raising and approving of only the `patch` and `minor` version update PRs of the dependencies, this is a safer alternative to `automerge-all.json`.|
| `./renovate/flux.json` | This preset is specific to `hmcts/cnp-flux-config` and `hmcts/sds-flux-config`, used to configure updates of specific dependencies in these repositories.
| `./renovate/global.json` | Deprecated, use ./renovate-config.json instead|
| `./renovate/cpp-terraform-azurerm-key-vault.json` | This is a Terraform module specific Renovate preset, use it to keep this Terraform up to date within your consuming repository. It will automatically raise and approve PRs (which will be merge if auto-merge is on) for `patch` and `minor` versions, will raise PRs requiring human review for `major` versions.

### Adding presets for Terraform modules

Please refer to [this readme](./documentation/adding-presets-for-modules.md) regarding adding Renovate presets for more Terraform modules.
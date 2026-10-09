#!/usr/bin/env bash

set -euo pipefail

RENOVATE_IMAGE="${RENOVATE_IMAGE:-renovate/renovate:latest}"
RENOVATE_CONFIG_FILE="${RENOVATE_CONFIG_FILE:-$PWD/renovate-config.json}"
RENOVATE_REPOSITORY="${RENOVATE_REPOSITORY:-}"
ENV_FILE="${ENV_FILE:-$PWD/.env}"

read -r -p "Renovate image [${RENOVATE_IMAGE}]: " input
RENOVATE_IMAGE="${input:-$RENOVATE_IMAGE}"

read -r -p "Renovate config file [${RENOVATE_CONFIG_FILE}] (e.g. ../repo/renovate.json): " input
RENOVATE_CONFIG_FILE="${input:-$RENOVATE_CONFIG_FILE}"

while [[ -z "$RENOVATE_REPOSITORY" ]]; do
	read -r -p "GitHub repository (e.g. hmcts/repo): " RENOVATE_REPOSITORY
done

if [[ ! -f "$ENV_FILE" ]]; then
	echo "Environment file not found: $ENV_FILE" >&2
	exit 1
fi

# shellcheck source=/dev/null
source "$ENV_FILE"
GITHUB_RENOVATE_TOKEN="${GITHUB_RENOVATE_TOKEN:-}"

if [[ -z "$GITHUB_RENOVATE_TOKEN" ]]; then
	echo "GITHUB_RENOVATE_TOKEN is missing or empty in $ENV_FILE" >&2
	exit 1
fi

if [[ ! -f "$RENOVATE_CONFIG_FILE" ]]; then
	echo "Renovate config file does not exist: $RENOVATE_CONFIG_FILE" >&2
	exit 1
fi

for command in az docker jq; do
	if ! command -v "$command" >/dev/null 2>&1; then
		echo "Required command not found: $command" >&2
		exit 1
	fi
done

# convert to absolute path
RENOVATE_CONFIG_FILE="$(cd "$(dirname "$RENOVATE_CONFIG_FILE")" && pwd)/$(basename "$RENOVATE_CONFIG_FILE")"
RENOVATE_ACR_APPID="00000000-0000-0000-0000-000000000000"

if ! RENOVATE_ACR_SECRET="$(az acr login --name hmctsprod --subscription DCD-CNP-PROD --expose-token --query accessToken --output tsv)"; then
	echo "Failed to acquire an ACR access token." >&2
	exit 1
fi

if [[ -z "$RENOVATE_ACR_SECRET" ]]; then
	echo "Azure CLI returned an empty ACR access token." >&2
	exit 1
fi

export RENOVATE_TOKEN="$GITHUB_RENOVATE_TOKEN"
export RENOVATE_ACR_APPID RENOVATE_ACR_SECRET
RENOVATE_SECRETS="$(jq -cn \
	--argjson existing "${RENOVATE_SECRETS:-null}" \
	--arg appid "$RENOVATE_ACR_APPID" \
	--arg secret "$RENOVATE_ACR_SECRET" \
	'($existing // {}) + {RENOVATE_ACR_APPID: $appid, RENOVATE_ACR_SECRET: $secret}')"
export RENOVATE_SECRETS

docker run --rm \
	-v "${RENOVATE_CONFIG_FILE}:/usr/src/app/renovate-config.json:ro" \
	-e RENOVATE_CONFIG_FILE="/usr/src/app/renovate-config.json" \
	-e RENOVATE_TOKEN \
	-e RENOVATE_HOST_RULES \
	-e RENOVATE_SECRETS \
	-e LOG_LEVEL=debug \
	"$RENOVATE_IMAGE" \
	renovate --platform=github --dry-run=full --onboarding=false \
	--require-config=ignored --autodiscover=false "$RENOVATE_REPOSITORY" \
	> renovate-dry-run.log 2>&1

printf 'Dry run complete. See renovate-dry-run.log for output.\n'
.PHONY: renovate

RENOVATE_CONFIG_FILE ?= $(PWD)/renovate-config.json
RENOVATE_IMAGE := renovate/renovate:latest

renovate:
	docker run --rm \
		-v "$(RENOVATE_CONFIG_FILE):/usr/src/app/renovate-config.json" \
		-e RENOVATE_CONFIG_FILE="/usr/src/app/renovate-config.json" \
		-e LOG_LEVEL="debug" \
		$(RENOVATE_IMAGE) \
		renovate-config-validator --strict /usr/src/app/renovate-config.json

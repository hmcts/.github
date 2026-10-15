.PHONY: renovate renovate-dry-run

renovate:
	docker run --rm \
		-v "$(RENOVATE_CONFIG_FILE):/usr/src/app/renovate-config.json" \
		-e RENOVATE_CONFIG_FILE="/usr/src/app/renovate-config.json" \
		-e LOG_LEVEL="debug" \
		$(RENOVATE_IMAGE) \
		renovate-config-validator /usr/src/app/renovate-config.json


renovate-dry-run:
	bash ./renovate-dry-run.sh

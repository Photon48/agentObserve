# Copyright (c) 2026 Rishu Goyal. All rights reserved.
# Licensed under the Business Source License 1.1.
# See LICENSE in the project root for license terms.

# agentObserve Docker shortcuts.
#
# Flag legend:
#   d = detached  (run containers in the background)
#   b = build     (rebuild images from current source before starting)
#
# Targets ending in `b` rebuild, then prune dangling images so the
# previous build's untagged layers don't accumulate in `docker images`.

.PHONY: up upd upb upbd down

# Foreground, no rebuild. Streams logs from the existing images.
up:
	docker compose up

# Detached, no rebuild.
upd:
	docker compose up -d

# Foreground, with rebuild. Prunes dangling images before the
# foreground `up` so Ctrl+C can't skip the cleanup.
upb:
	docker compose build
	docker image prune -f
	docker compose up

# Detached, with rebuild. Canonical upgrade command:
# `git pull && make upbd`.
upbd:
	docker compose up --build -d
	docker image prune -f

# Stop and remove containers. Telemetry in ./telemetry/ is preserved.
down:
	docker compose down

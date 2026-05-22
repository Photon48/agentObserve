.PHONY: setup start stop restart status logs start-receiver start-express start-vite stop-receiver stop-express stop-vite

setup:
	@echo "Checking prerequisites..."
	@command -v node >/dev/null 2>&1 || { echo "Error: node is required. Install from https://nodejs.org"; exit 1; }
	@command -v uv >/dev/null 2>&1 || { echo "Error: uv is required. Install with: curl -LsSf https://astral.sh/uv/install.sh | sh"; exit 1; }
	@echo "Creating Python virtual environment..."
	@uv venv .venv
	@uv sync
	@echo "Installing Node dependencies..."
	@npm install
	@mkdir -p telemetry
	@echo ""
	@echo "Setup complete. Run 'make start' to launch agentObserve."

PID_DIR := .pids
LOG_DIR := .logs

RECEIVER_PID := $(PID_DIR)/receiver.pid
EXPRESS_PID  := $(PID_DIR)/express.pid
VITE_PID     := $(PID_DIR)/vite.pid

RECEIVER_LOG := $(LOG_DIR)/receiver.log
EXPRESS_LOG  := $(LOG_DIR)/express.log
VITE_LOG     := $(LOG_DIR)/vite.log

define check_running
	@if [ -f $(1) ] && kill -0 $$(cat $(1)) 2>/dev/null; then \
		echo "$(2) is already running (PID $$(cat $(1)))"; \
		false; \
	fi
endef

define stop_service
	@if [ -f $(1) ]; then \
		pid=$$(cat $(1)); \
		if kill -0 $$pid 2>/dev/null; then \
			kill $$pid 2>/dev/null; \
			echo "$(2) stopped (PID $$pid)"; \
		else \
			echo "$(2) was not running (stale PID $$pid)"; \
		fi; \
		rm -f $(1); \
	else \
		echo "$(2) is not running"; \
	fi
endef

define show_status
	@if [ -f $(1) ] && kill -0 $$(cat $(1)) 2>/dev/null; then \
		printf "  %-12s \033[32mrunning\033[0m  PID %-8s port %s\n" "$(2)" "$$(cat $(1))" "$(3)"; \
	else \
		printf "  %-12s \033[31mstopped\033[0m\n" "$(2)"; \
		rm -f $(1) 2>/dev/null; \
	fi
endef

start: start-receiver start-express start-vite
	@echo ""
	@$(MAKE) --no-print-directory status

stop: stop-receiver stop-express stop-vite

restart: stop
	@sleep 1
	@$(MAKE) --no-print-directory start

status:
	@echo "Service status:"
	$(call show_status,$(RECEIVER_PID),receiver,4318)
	$(call show_status,$(EXPRESS_PID),express,3001)
	$(call show_status,$(VITE_PID),vite,5173)

logs:
	@tail -f $(RECEIVER_LOG) $(EXPRESS_LOG) $(VITE_LOG)

start-receiver:
	@mkdir -p $(PID_DIR) $(LOG_DIR)
	@if [ -f $(RECEIVER_PID) ] && kill -0 $$(cat $(RECEIVER_PID)) 2>/dev/null; then \
		echo "receiver is already running (PID $$(cat $(RECEIVER_PID)))"; \
	else \
		.venv/bin/uvicorn otel_receiver:app --host 0.0.0.0 --port 4318 --log-level warning \
			> $(RECEIVER_LOG) 2>&1 & echo $$! > $(RECEIVER_PID); \
		echo "receiver started (PID $$(cat $(RECEIVER_PID)))"; \
	fi

start-express:
	@mkdir -p $(PID_DIR) $(LOG_DIR)
	@if [ -f $(EXPRESS_PID) ] && kill -0 $$(cat $(EXPRESS_PID)) 2>/dev/null; then \
		echo "express is already running (PID $$(cat $(EXPRESS_PID)))"; \
	else \
		node server/index.js \
			> $(EXPRESS_LOG) 2>&1 & echo $$! > $(EXPRESS_PID); \
		echo "express started (PID $$(cat $(EXPRESS_PID)))"; \
	fi

start-vite:
	@mkdir -p $(PID_DIR) $(LOG_DIR)
	@if [ -f $(VITE_PID) ] && kill -0 $$(cat $(VITE_PID)) 2>/dev/null; then \
		echo "vite is already running (PID $$(cat $(VITE_PID)))"; \
	else \
		npx vite \
			> $(VITE_LOG) 2>&1 & echo $$! > $(VITE_PID); \
		echo "vite started (PID $$(cat $(VITE_PID)))"; \
	fi

stop-receiver:
	$(call stop_service,$(RECEIVER_PID),receiver)

stop-express:
	$(call stop_service,$(EXPRESS_PID),express)

stop-vite:
	$(call stop_service,$(VITE_PID),vite)

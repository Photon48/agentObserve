# Copyright (c) 2026 Rishu Goyal. All rights reserved.
# Licensed under the Business Source License 1.1.
# See LICENSE in the project root for license terms.

FROM python:3.12-slim AS base

# uv: fast Python package + venv manager. Pinned for reproducibility.
COPY --from=ghcr.io/astral-sh/uv:0.5.11 /uv /uvx /usr/local/bin/

WORKDIR /app

# Install deps first so subsequent code edits don't bust the layer.
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev

COPY otel_receiver.py VERSION ./

ENV TELEMETRY_DIR=/data \
    PYTHONUNBUFFERED=1

EXPOSE 4318

CMD ["uv", "run", "uvicorn", "otel_receiver:app", \
     "--host", "0.0.0.0", "--port", "4318", "--log-level", "warning"]

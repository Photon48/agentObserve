# Copyright (c) 2026 Rishu Goyal. All rights reserved.
# Licensed under the Business Source License 1.1.
# See LICENSE in the project root for license terms.

FROM node:20-alpine

WORKDIR /app

# Cache install layer: copy manifests first, then source.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server/ ./server/
COPY VERSION ./

ENV TELEMETRY_DIR=/data \
    NODE_ENV=production \
    PORT=3001

EXPOSE 3001

CMD ["node", "server/index.js"]

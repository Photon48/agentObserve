# Copyright (c) 2026 Rishu Goyal. All rights reserved.
# Licensed under the Business Source License 1.1.
# See LICENSE in the project root for license terms.

# Stage 1 — build the React/Vite bundle.
FROM node:20-alpine AS build

WORKDIR /app

COPY package.json package-lock.json vite.config.js index.html ./
RUN npm ci
COPY src/ ./src/
COPY VERSION ./
RUN npm run build

# Stage 2 — serve static assets via nginx; proxy /api → api:3001.
FROM nginx:1.27-alpine AS runtime

COPY docker/ui/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
COPY VERSION /usr/share/nginx/html/VERSION

EXPOSE 80

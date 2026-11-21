FROM node:24-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY prisma ./prisma
RUN XDG_CACHE_HOME=/tmp/prisma-cache npm run db:generate

COPY src ./src
COPY admin-ui ./admin-ui
RUN npm run ui:build
COPY scripts ./scripts

USER node
CMD ["npm", "start"]

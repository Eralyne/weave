FROM node:22-slim

WORKDIR /app

# Native addon build dependencies for tree-sitter and better-sqlite3
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/cli/package.json packages/cli/
COPY packages/mcp/package.json packages/mcp/

RUN npm ci

COPY tsconfig.json ./
COPY packages/ packages/

RUN npm run build --workspace=@weave/core && \
    npm run build --workspace=@weave/cli && \
    npm run build --workspace=@weave/mcp

ENTRYPOINT ["node", "/app/packages/cli/dist/bin.js"]

# One image for the three backend process roles (Technical architecture §2).
# Choose the role at runtime: ROLE=web | worker | egress.
# The dashboard ships separately (Next.js standalone output).

FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile --ignore-scripts \
 && pnpm --filter @aiw/web --filter @aiw/worker --filter @aiw/egress build

FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY apps/egress/package.json apps/egress/
COPY packages/config/package.json packages/config/
COPY packages/logger/package.json packages/logger/
COPY packages/db/package.json packages/db/
RUN pnpm install --prod --frozen-lockfile --ignore-scripts \
      --filter @aiw/web... --filter @aiw/worker... --filter @aiw/egress...

FROM base AS runtime
ENV NODE_ENV=production LOG_FORMAT=json ROLE=web
COPY --from=prod-deps /app ./
COPY --from=build /app/apps/web/dist apps/web/dist
COPY --from=build /app/apps/worker/dist apps/worker/dist
COPY --from=build /app/apps/worker/workflow-bundle.js apps/worker/workflow-bundle.js
COPY --from=build /app/apps/egress/dist apps/egress/dist
COPY scripts/start-role.sh scripts/start-role.sh
USER node
CMD ["sh", "scripts/start-role.sh"]

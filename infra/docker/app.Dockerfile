# syntax=docker/dockerfile:1
# Single image used by apps/api and apps/worker (select via APP_ENTRY / command).

FROM node:24-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# Skip husky's git-hook install during image builds (no .git in the context)
ENV HUSKY=0
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json turbo.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY packages ./packages
# onlyBuiltDependencies lives in pnpm-workspace.yaml; restate it as an env var so
# the setting is unambiguous inside the build regardless of pnpm's config merge.
ENV npm_config_only_built_dependencies=esbuild
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
# Remove any stale incremental-build state so tsc cannot skip emit.
RUN find . -name '*.tsbuildinfo' -delete
RUN pnpm build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app ./
# Non-root
RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app
CMD ["node", "apps/api/dist/index.js"]

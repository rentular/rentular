# Test runner image for the Rentular browser tests.
#
# Based on the official Playwright image whose version matches the
# "playwright" package in pnpm-lock.yaml (1.58.2), so Chromium and WebKit
# are already inside and nothing is downloaded at test time. Bump both
# together.
#
# Build context: the repository root (see e2e/docker-compose.e2e.yml).
FROM mcr.microsoft.com/playwright:v1.58.2-noble

ENV CI=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NEXT_TELEMETRY_DISABLED=1

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

WORKDIR /repo
COPY . .

# Only what the runner needs: the e2e package (playwright, mysql2, bcrypt,
# tsx) and packages/db for drizzle-kit (schema push).
RUN pnpm install --frozen-lockfile --filter @rentular/e2e --filter @rentular/db \
    && chown -R pwuser:pwuser /repo

USER pwuser
CMD ["bash", "e2e/scripts/container-run.sh"]

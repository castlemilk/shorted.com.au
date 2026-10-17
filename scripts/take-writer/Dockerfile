# Investigative newsroom job image. Runs the take-writer CLI; the Cloud
# Run Job passes the command as args, e.g.:
#   ["newsroom-daily", "--auto-publish", "--with-images"]
#   ["publish-content", "--slug=<slug>"]   (shorted-news-publish, via the admin API)
# Env (DATABASE_URL, GEMINI_API_KEY, OPENAI_API_KEY, GCS_LOGO_BUCKET) is
# injected by the job; GCS auth uses the job's service-account ADC.
FROM node:24-slim

WORKDIR /app

# Install deps (tsx is a devDependency and is needed at runtime, so we do
# a full `npm ci` rather than --omit=dev).
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# The newsroom pipeline (newsroom-daily) runs fully HEADLESS — no browser is
# needed. The validator's full-page screenshot step uses Playwright/chromium
# only when available; without a chromium binary it degrades gracefully to
# per-image judging (see src/validator.ts). We deliberately do NOT install the
# browser here to keep the image lean. To enable full-page screenshot
# validation IN the container, uncomment:
#   RUN npx playwright install --with-deps chromium

COPY tsconfig.json ./
COPY src ./src

# Hand-written /news articles, baked in so `publish-content --slug=...` (the
# shorted-news-publish Cloud Run job) publishes exactly what was merged to
# main. content/news sits outside this directory, so it arrives as a NAMED
# build context rather than by widening the build context to the repo root:
#
#   docker build --build-context content=../../content/news .
#
# CI passes the same thing through build-push-action's `build-contexts`.
COPY --from=content . ./content/news
ENV CONTENT_DIR=/app/content/news

ENTRYPOINT ["npx", "tsx", "src/index.ts"]

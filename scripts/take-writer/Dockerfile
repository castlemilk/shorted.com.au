# Investigative newsroom job image. Runs the take-writer CLI; the Cloud
# Run Job passes the command as args, e.g.:
#   ["newsroom-daily", "--auto-publish", "--with-images"]
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

ENTRYPOINT ["npx", "tsx", "src/index.ts"]

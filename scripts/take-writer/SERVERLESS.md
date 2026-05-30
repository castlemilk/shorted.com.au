# Serverless newsroom — portability runbook

How to run the investigative newsroom (`take-writer`) as a Cloud Run Job. No
infrastructure is provisioned by this doc — it documents the steps and the
already-prepared pieces.

## It already runs headless

`newsroom-daily [--auto-publish] [--with-images]` is the serverless entrypoint.
It uses only environment variables and ambient Application Default Credentials
(ADC) — no browser, no local credential files:

- Gemini / OpenAI / Postgres are reached over their network APIs.
- GCS uses `new Storage()`, which picks up the job's service-account ADC.

The **only** browser-bearing code path is the validator's full-page screenshot.
That step now degrades gracefully: `src/validator.ts` dynamically imports
Playwright and returns `null` if Playwright or a chromium binary isn't
available (or if `VALIDATOR_SCREENSHOT=0`). When there's no screenshot, the
judge falls back to **per-image** cohesion judging — it scores each layout image
against its caption + the body, instead of also seeing a full-page render. The
same code runs identically in a lean container.

- Force-skip the screenshot: set `VALIDATOR_SCREENSHOT=0`.
- Enable full-page screenshot validation in-container: add
  `RUN npx playwright install --with-deps chromium` to the `Dockerfile`
  (deliberately omitted by default to keep the image small).

## Image

`Dockerfile` (node:22-slim). The entrypoint is `npx tsx src/index.ts`, so the
Cloud Run Job passes the command + flags as container args, e.g.
`["newsroom-daily", "--auto-publish", "--with-images"]`.

Build to the target project's Artifact Registry:

```bash
gcloud builds submit --project <PROJ> \
  --tag <region>-docker.pkg.dev/<PROJ>/shorted/take-writer:latest .
```

Currently built to dev:
`australia-southeast2-docker.pkg.dev/shorted-dev-aba5688f/shorted/take-writer:latest`.

## Env / secrets the job needs

Required:

| Var | Purpose |
|---|---|
| `DATABASE_URL` | Postgres (editorial_takes etc.) |
| `GEMINI_API_KEY` | editor / investigator / writer / validator models |
| `OPENAI_API_KEY` | image generation (`--with-images`, validator auto-fix) |
| `GCS_LOGO_BUCKET` | image upload bucket (default `shorted-company-logos`) |

Optional model overrides:
`EDITOR_MODEL`, `INVESTIGATOR_MODEL_TAKE`, `INVESTIGATOR_MODEL_DEEPDIVE`,
`WRITER_MODEL`, `WRITER_MODEL_DEEPDIVE`, `ART_DIRECTOR_MODEL`, `VALIDATOR_MODEL`.

Optional caps:
`MAX_TAKES_PER_DAY`, `MAX_DEEPDIVES_PER_DAY`, `MAX_TURNS_TAKE`,
`MAX_TURNS_DEEPDIVE`.

Optional validator toggle: `VALIDATOR_SCREENSHOT=0` to force per-image-only.

**GCS auth = the job's service account (ambient ADC). Do NOT set
`GOOGLE_APPLICATION_CREDENTIALS` on the job** — that's a local-only mechanism.

## Terraform (ready, not applied)

`terraform/modules/newsroom-job/` defines a Cloud Run Job + Cloud Scheduler
(scheduler in `australia-southeast1`). It is referenced in
`terraform/environments/dev/main.tf` (`module "newsroom_job"`) but **NOT yet
applied**. The prod environment does not reference it yet.

To enable in an environment:

1. Build the image to that env's Artifact Registry (see above).
2. Ensure the secrets (`DATABASE_URL`, `GEMINI_API_KEY`, `OPENAI_API_KEY`)
   exist in Secret Manager and the job's service account can read them + write
   to the GCS bucket.
3. `terraform apply`.

## Local CLI usage (unchanged)

```bash
cd scripts/take-writer
npx tsx src/index.ts newsroom-preview --stock=CODE   # investigate one stock, no DB write, no images
npx tsx src/index.ts newsroom-daily [--auto-publish] [--with-images]
npx tsx src/index.ts regen-images --slug=SLUG [--inline=2]
npx tsx src/index.ts validate-article --slug=SLUG [--rounds=2]
```

Local image generation needs Google creds: set
`GOOGLE_APPLICATION_CREDENTIALS` to the `ben@shorted.com.au` adc.json. (This is
the local-only path; the Cloud Run Job uses its service-account ADC instead.)

## Migration state

Migrations `038` (tier) and `040` (layout_images) were applied to prod directly
— the `migrate` tool is version-drifted, so they were run by hand (see project
memory). A fresh environment needs both applied before the newsroom can write
takes with tier + layout_images.

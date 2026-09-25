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

`Dockerfile` (node:24-slim). The entrypoint is `npx tsx src/index.ts`, so the
Cloud Run Job passes the command + flags as container args, e.g.
`["newsroom-daily", "--auto-publish", "--with-images"]`.

Build to the target project's Artifact Registry:

```bash
gcloud builds submit --project <PROJ> \
  --tag <region>-docker.pkg.dev/<PROJ>/shorted/take-writer:latest .
```

Currently built to dev:
`${ARTIFACT_REGISTRY}/${GCP_PROJECT_ID}/shorted/take-writer:latest`; both
variables must be supplied explicitly.

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

## Publishing a hand-written article from anywhere (LIVE in prod)

`shorted-news-publish` is a prod Cloud Run Job (take-writer image, provisioned
by `module "shorted_job_news_publish"` in `terraform/environments/prod/main.tf`)
that publishes ONE merged `content/news/*.mdx` article with the full chain:
upsert → images → vision check → `published_at` → revalidate `/news`. The
caller needs no database URL, model keys or GCS credentials — only
`NEWS_PUBLISH_TOKEN`, a Terraform-generated secret that **only this endpoint
accepts** (the `INTERNAL_SERVICE_SECRET` also works, but it opens every admin
route). Read it with:

```bash
gcloud secrets versions access latest --secret=NEWS_PUBLISH_TOKEN --project=rosy-clover-477102-t5
```

```bash
# from a checkout (NEWS_PUBLISH_TOKEN from env, else INTERNAL_SERVICE_SECRET, else gcloud):
CONFIRM=prod task news:publish:remote SLUG=<slug>            # images on
CONFIRM=prod task news:publish:remote SLUG=<slug> NO_IMAGES=1

# or directly:
curl -X POST https://api.shorted.com.au/api/admin/news/publish \
  -H "x-news-publish-token: $NEWS_PUBLISH_TOKEN" -H "Content-Type: application/json" \
  -d '{"slug":"<slug>"}'                       # → 202 {"executionName":...}
curl -H "x-news-publish-token: $NEWS_PUBLISH_TOKEN" \
  "https://api.shorted.com.au/api/admin/news/publish?execution=<executionName>"
                                               # → {"status":"running|succeeded|failed","logUri":...}
```

How it is kept narrow:

- **The article must be merged to `main`.** `content/news` is baked into the
  image at build time (a named `content` build context — `docker build
  --build-context content=../../content/news .`), and CI rebuilds it on every
  push to main. The API carries a slug, never an article body.
- **The API builds the argv** (`publish-content --slug=<slug> [--no-images]`)
  from a slug matching `^[a-z0-9]+(-[a-z0-9]+)*$`
  (`services/shorts/internal/jobmonitor/publish.go`, mirrored in
  `src/import-mdx.ts`; `scripts/tests/news-publish-job.test.mjs` pins they agree).
- **Only the shorts-api SA can pass an override**, via `roles/run.developer`
  scoped to this one job. The job is not in the fleet "Run now" map, and its
  deployed args are `list-drafts`, so a bare execution writes nothing.
- **No retries, and a running publish refuses a second** (409, `force:true`
  overrides): a retry would pay for images twice.
- Gemini uses `GEMINI_API_KEY_NEWS` (per-workload isolation); images go to
  `shorted-company-logos-prod`.

The locally run `publish-content --slug=...` does the same thing against
whatever `DATABASE_URL` you export (it reads `../../content/news` by default).

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

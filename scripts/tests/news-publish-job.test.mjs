// The shorted-news-publish job: POST /api/admin/news/publish runs it with an
// argv override built server-side (services/shorts/internal/jobmonitor/publish.go).
// These pin the infrastructure half of that contract — the half a refactor of
// main.tf or the deploy workflow could silently break.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const prodMain = read("../../terraform/environments/prod/main.tf");
const prodVars = read("../../terraform/environments/prod/variables.tf");
const workflow = parse(read("../../.github/workflows/terraform-deploy.yml"));
const dockerfile = read("../take-writer/Dockerfile");
const publishGo = read("../../services/shorts/internal/jobmonitor/publish.go");
const importMdx = read("../take-writer/src/import-mdx.ts");

function block(kind, name) {
  const start = prodMain.indexOf(`${kind} "${name}"`);
  assert.ok(start >= 0, `${kind} ${name} should exist in prod main.tf`);
  const next = prodMain.indexOf("\n}\n", start);
  return prodMain.slice(start, next + 2);
}

const job = block("module", "shorted_job_news_publish");

test("the job name matches the constant the API is allowed to run", () => {
  const constant = /const PublishJobName = "([^"]+)"/.exec(publishGo)?.[1];
  assert.equal(constant, "shorted-news-publish");
  assert.match(job, new RegExp(`name\\s+=\\s+"${constant}"`));
});

test("a bare execution cannot publish: deployed args are read-only and there is no schedule", () => {
  assert.match(job, /args\s+=\s+\["list-drafts"\]/);
  assert.match(job, /schedule\s+=\s+""/);
  // A retry re-pays for image generation; a failed publish is safe to re-run by hand.
  assert.match(job, /max_retries\s+=\s+0/);
});

test("the override grant is run.developer on THIS job only, and it is not in the fleet Run-now map", () => {
  const grant = block("resource", "google_cloud_run_v2_job_iam_member\" \"shorts_api_news_publish");
  assert.match(grant, /name\s+=\s+module\.shorted_job_news_publish\.job_name/);
  assert.match(grant, /role\s+=\s+"roles\/run\.developer"/);
  assert.match(grant, /module\.shorts_api\.service_account_email/);

  const runnable = prodMain.slice(prodMain.indexOf("admin_runnable_jobs = {"));
  const runnableMap = runnable.slice(0, runnable.indexOf("\n  }\n"));
  assert.doesNotMatch(runnableMap, /shorted_job_news_publish/);
});

test("the job holds every credential publishing needs, from Secret Manager", () => {
  for (const [env, secret] of [
    ["DATABASE_URL", "DATABASE_URL"],
    ["GEMINI_API_KEY", "GEMINI_API_KEY_NEWS"],
    ["OPENAI_API_KEY", "OPENAI_API_KEY"],
    ["REVALIDATION_SECRET", "REVALIDATION_SECRET"],
  ]) {
    assert.match(job, new RegExp(`${env}\\s+=\\s+"${secret}"`), `${env} should come from ${secret}`);
  }
  assert.match(job, /CONTENT_DIR\s+=\s+"\/app\/content\/news"/);
  assert.match(job, /GCS_LOGO_BUCKET\s+=\s+local\.shared_asset_buckets\.company_logos/);
});

test("the job can write article images to the public logo bucket", () => {
  const grant = block("resource", "google_storage_bucket_iam_member\" \"company_logos_news_publish_writer");
  assert.match(grant, /shared_assets\["company_logos"\]/);
  assert.match(grant, /module\.shorted_job_news_publish\.service_account_email/);
});

test("CI builds take-writer with content/news baked in and deploys that exact tag", () => {
  const matrix = workflow.jobs["build-docker-images"].strategy.matrix.service;
  const tw = matrix.find((s) => s.name === "take-writer");
  assert.ok(tw, "take-writer should be in the image build matrix");
  assert.equal(tw.context, "scripts/take-writer");
  assert.equal(tw.build_contexts, "content=content/news");

  const build = workflow.jobs["build-docker-images"].steps.find((s) => s.uses?.startsWith("docker/build-push-action"));
  assert.equal(build.with["build-contexts"], "${{ matrix.service.build_contexts }}");

  const source = read("../../.github/workflows/terraform-deploy.yml");
  const passes = source.match(/-var="take_writer_image=[^"]*take-writer:\$\{\{ needs\.determine-environment\.outputs\.image-tag \}\}"/g) ?? [];
  assert.equal(passes.length, 2, "both plan and apply must pass take_writer_image");
  assert.match(prodVars, /variable "take_writer_image"/);
});

test("the image receives the articles through the named `content` context", () => {
  assert.match(dockerfile, /COPY --from=content \. \.\/content\/news/);
  assert.match(dockerfile, /ENV CONTENT_DIR=\/app\/content\/news/);
});

test("the Go and TypeScript slug rules agree", () => {
  const goPattern = /slugPattern = regexp\.MustCompile\(`([^`]+)`\)/.exec(publishGo)?.[1];
  const tsPattern = /export const SLUG_PATTERN = \/(.+)\/;/.exec(importMdx)?.[1];
  assert.equal(goPattern, tsPattern);
  const goMax = /const maxSlugLength = (\d+)/.exec(publishGo)?.[1];
  const tsMax = /export const MAX_SLUG_LENGTH = (\d+);/.exec(importMdx)?.[1];
  assert.equal(goMax, tsMax);
});

test("a publish-only token is generated into Secret Manager and handed to the API", () => {
  const api = read("../../terraform/modules/shorts-api/main.tf");
  assert.match(api, /resource "random_password" "news_publish_token"/);
  assert.match(api, /secret_id = "NEWS_PUBLISH_TOKEN"/);
  assert.match(api, /name = "NEWS_PUBLISH_TOKEN"/);
  assert.match(prodMain, /source\s+=\s+"hashicorp\/random"/);
  // Only the publish route accepts it.
  const serve = read("../../services/shorts/internal/services/shorts/serve.go");
  const uses = serve.match(/newsPublishAuthMiddleware\(/g) ?? [];
  assert.equal(uses.length, 1);
  assert.match(serve, /"\/api\/admin\/news\/publish", newsPublishAuthMiddleware\(/);
});

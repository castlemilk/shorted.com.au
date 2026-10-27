# Optional metrics routing through Telesis

Shorted can send application metrics to Telesis while keeping its existing
Grafana trace endpoint and credentials. Reusable module defaults remain disabled.
The reviewed production profile opts in through `terraform/environments/prod/metrics-routing.auto.tfvars`
and the jobs chart values, after the receiver and dedicated credentials are ready.
Routing does not start any business job.

## Coverage

The production `otel_metrics` Terraform input covers the Cloud Run resources
configured for the shared Go SDK, including retained and manually executable
templates:

| Deployment | Covered resources |
| --- | --- |
| APIs | `shorts-api`, `market-data`, `chat-service`, `enrichment-processor` |
| Consolidated jobs | Announcements, price sync, weekly reports, index sync and news (including its extra schedules) |
| Discovery and sync | The scheduled ASX discovery job and live market-data-sync HTTP service, including their legacy image fallback |
| Retained templates | The paused standalone weekly report job and paused Cloud Run index/news templates |

The existing consolidated Signals and index-sync templates also receive the
optional routing input because they already declare OTLP configuration. Their
entry points do not currently initialize the shared SDK; routing configuration
alone is not evidence of Signals or index-sync metric emission. Python collectors
and other workloads without the shared SDK are outside this change.

Each runtime service account gets access only to the configured metrics header
secret when enabled, and the workload waits for that grant. Generic
`OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_HEADERS` stay unchanged.
The ASX discovery job is still scheduled on Cloud Run. The market-data-sync
HTTP service remains live even though its daily sweep scheduler is paused.

For Kubernetes, `profiles.otel.metrics` applies only to jobs with the `otel`
profile. Of the eight currently enabled jobs, six have it: `shorted-news-cluster`,
`shorted-index-sync`, `shorted-news`, `shorted-news-backfill-images`,
`shorted-news-resolve-googlenews` and `shorted-news-digest`. The index-sync caveat
above applies to its Kubernetes template too. Economy and alerts
do not currently use this profile or the shared instrumentation. Suspended jobs
remain suspended; routing does not change images, schedules or enabled jobs.

Logo discovery telemetry comes from the enrichment processor's actual discovery
work. Serving an existing logo from GCS produces no discovery metric. Validate
with ordinary scheduled work; do not trigger enrichment or other business jobs
solely to generate telemetry. Empty historical windows remain honestly empty.

## Receiver and credential prerequisites

Before enabling either deployment:

1. Deploy the authenticated Telesis metrics gateway and the Cuttlefish native
   Prometheus OTLP receiver. The intended public endpoint is exactly
   `https://origin-vke.telesis.dev/v1/metrics`. Tempo handles traces and cannot
   receive this metrics signal. Prometheus's generic HTTP API stays private.
2. Verify the gateway's durable queue and Prometheus storage, plus its bounded
   out-of-order replay window. Use the shared SDK's process-unique
   `service.instance.id` so multiple workers do not overwrite one time series.
3. Provision a dedicated ingestion credential in the existing Cuttlefish
   `shorted` project / `prod` environment secret store under
   `TELESIS_OTLP_METRICS_HEADERS`. Its value uses OTel header syntax:
   `Authorization=Bearer%20<ingestion-token>`. Never copy Grafana credentials,
   commit a token, pass it on a command line or put it in Terraform variables.
   Keep the project and environment copies coordinated: the plan job reads the
   project copy; the apply job reads the `prod` override when present.
4. Run the normal Terraform deployment pipeline. Its existing WIF identity
   provisions this optional Secret Manager secret only when supplied. Plan is
   create-only; apply owns versions. Pull requests make no secret writes. Empty
   optional input leaves the existing secret untouched. The route is still off.

The existing `scripts/ensure-secret.sh` sends bytes through stdin, suppresses
xtrace and avoids unnecessary versions. The new setting does not read a secret
value into Terraform state; only the Secret Manager ID enters the plan.

## Cloud Run enablement

The committed `terraform/environments/prod/metrics-routing.auto.tfvars` supplies
the following non-secret production input to the normal Terraform pipeline:

```hcl
otel_metrics = {
  enabled        = true
  endpoint       = "https://origin-vke.telesis.dev/v1/metrics"
  headers_secret = "TELESIS_OTLP_METRICS_HEADERS"
}
```

This adds only four metric-specific environment settings: endpoint, HTTP/protobuf
protocol, cumulative temporality and a Secret Manager header reference. Each
service or job has a dependency on its narrowly scoped secret-access grant. Setting
`enabled = false` removes those overrides and the extra grant; the SDK returns
to the existing generic Grafana route. Keep generic OTel configuration present:
the shared SDK uses it to initialize telemetry.

## Kubernetes enablement

Stage a values file containing no credentials:

```yaml
profiles:
  otel:
    metrics:
      enabled: true
      endpoint: https://origin-vke.telesis.dev/v1/metrics
      headersSecretKey: TELESIS_OTLP_METRICS_HEADERS
```

First run `deploy/kubernetes/jobs/scripts/sync-secrets.sh -f <values-file>` with
the explicit Omega kubeconfig and the existing authenticated Secret Manager
access. This is a plan by default; it renders the requested profile and checks
that every required Secret Manager ID exists. After reviewing the context and
key list, the existing `CONFIRM=prod` mode copies them to `shorted-jobs-env`.
It refuses to apply anything if a key is missing, its latest version cannot be
read, or its value is empty. The complete Secret is buffered privately in memory
before applying; credential bytes never reach logs, files or process arguments. Only forward the
metrics profile overrides here; this helper reads the base `secretEnv.secretName`.

The committed jobs-chart profile enables the same route. Keep the override file
when invoking secret sync so its preflight includes the dedicated key.
Paprika follows `deploy/vke-jobs`, not `main`: the normal Terraform pipeline's
`bump-vke-jobs-image` step advances that deployment branch after apply succeeds.
There is no automatic Kubernetes Secret synchronization in that pipeline, so
prepare the key before enabling the profile. Do not run a CronJob manually.

## Validation

Local/CI contract checks require Helm, mikefarah yq v4, jq, Python with PyYAML and
Terraform 1.14.6. The existing render script also requires Bash 4 or newer.

```sh
bash deploy/kubernetes/jobs/chart/tests/render.sh
python3 scripts/tests/metrics-routing.test.py
python3 terraform/tests/metrics-routing/run.py
node --test scripts/tests/ensure-secret.test.mjs scripts/tests/terraform-provider-pins.test.mjs
```

The render tests compare every default object and remove only the four new
metric env entries from the enabled render before comparing it again. The
pipeline and secret-preflight tests stub external cloud commands; Terraform
uses mock providers in temporary copies, no backend, no production state and
no cloud credentials. The real Google provider schema is pinned to production's
version. Mock plans cover all eight resource shapes across seven modules,
including both discovery runtime identities and the generic jobs module. The
tests compare every non-metrics environment entry between disabled and enabled
plans and require the dedicated secret grant for the intended runtime account.
A production call-site inventory guards against leaving an OTLP-enabled shared
job on the old metrics route. These tests run in Repository Hygiene's VKE jobs
chart job.

After an authorized rollout, check the actual Cloud Run revisions and CronJob
templates, receiver accepted/refused counts, exporter failures, queue depth and
Prometheus samples for the expected service and process identity. Compare
request rates, error labels and histogram units against the originating SDK.
Use Paprika observe and the dashboard's shared filter against those real
series; verify traces still arrive at their previous destination. Avoid claiming
coverage until the relevant application has emitted real traffic.

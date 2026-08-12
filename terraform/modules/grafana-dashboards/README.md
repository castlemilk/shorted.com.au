# Grafana dashboards

Dashboard definitions for Grafana Cloud, kept as code.

## This module is NOT applied by the environment stacks

It used to be, and that was a mistake: nothing in the infrastructure depends on
these dashboards, but managing them alongside Cloud Run meant every `terraform
plan` had to refresh `grafana_folder.shorted` against Grafana Cloud's API. A
transient 5xx there failed the entire production deploy — which happened on three
consecutive deploys in August 2026, each recovering only on a manual re-run. The
Grafana provider already retries 5xx by default (3 attempts, 30s apart), so the
fix was to remove the coupling, not to retry harder.

`terraform/environments/prod/main.tf` therefore carries a `removed` block with
`lifecycle { destroy = false }`: the resources were dropped from state without
being deleted, so the dashboards keep serving.

## Applying it

Because the resources are no longer in the environment state, a plan here will
want to CREATE them, which Grafana treats as an upsert for a folder+dashboards of
the same title (`grafana_dashboard.overwrite = true`). Apply it on its own, when
the dashboards actually change, from a directory with its own state:

```hcl
module "grafana_dashboards" {
  source       = "../../modules/grafana-dashboards"
  grafana_url  = var.grafana_url
  grafana_auth = var.grafana_auth   # a Grafana Cloud service-account token
}
```

If you would rather not run Terraform for this at all, the dashboard JSON in
`main.tf` can be pasted into Grafana's import UI — the `config_json` values are
plain dashboard models.

## Why keep it in the repo

The definitions are real work and reviewing a dashboard change as a diff is worth
more than the convenience of clicking around the UI. Keeping them here costs
nothing now that they are off the deploy path.

# Decommission shim for the Grafana Cloud dashboards.
#
# WHY THIS EXISTS AS A MODULE AT ALL
#
# The dashboards were managed by module.grafana_dashboards, which declared its
# own `provider "grafana"` block. Deleting the module call outright does not
# work: Terraform still holds the resources in state, and to process them it
# needs the provider configuration at its ORIGINAL address —
# module.grafana_dashboards.provider["registry.terraform.io/grafana/grafana"].
# Removing the module removes that provider config too, so the plan fails with
# "Provider configuration not present" and nothing can proceed. (Verified: that
# is exactly how the first attempt failed on the prod plan.)
#
# A state address is derived from the module CALL name, not its source. So the
# environment keeps calling this `module "grafana_dashboards"`, pointed here:
# the provider configuration lives at the address the orphans expect, and the
# `removed` blocks take them out of state.
#
# `destroy = false` is the load-bearing part — it forgets the resources instead
# of deleting them, so the dashboards keep serving in Grafana Cloud.
#
# ONCE ONE PROD APPLY HAS PROCESSED THIS, state holds no grafana resources and
# this whole module plus its call can be deleted. Until then it must stay.
#
# The dashboard definitions themselves are untouched in
# terraform/modules/grafana-dashboards/ — see that module's README.

terraform {
  required_providers {
    grafana = {
      source  = "grafana/grafana"
      version = "~> 3.0"
    }
  }
}

# Required for the orphaned resources to resolve. It is never contacted: with no
# resources left to refresh, nothing calls the Grafana API — which is the entire
# point of this change, since a 5xx from that API was failing production deploys.
provider "grafana" {
  url  = var.grafana_url
  auth = var.grafana_auth
}

removed {
  from = grafana_folder.shorted

  lifecycle {
    destroy = false
  }
}

removed {
  from = grafana_dashboard.operations

  lifecycle {
    destroy = false
  }
}

# Terraform Makefile for Shorted Infrastructure

.PHONY: help init plan apply destroy format validate clean

# No cloud environment is implicit. The retired dev configuration has been
# removed; callers must pass ENV=prod and GCP_PROJECT_ID explicitly.
ENV ?= unconfigured
GCP_PROJECT_ID ?=

help: ## Show this help message
	@echo "Terraform Infrastructure Management"
	@echo ""
	@echo "Usage: make [target] ENV=<environment>"
	@echo ""
	@echo "Targets:"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'
	@echo ""
	@echo "Environments:"
	@echo "  prod  - Production (explicit only)"
	@echo ""
	@echo "Examples:"
	@echo "  make plan ENV=prod     # Plan production changes"
	@echo "  make apply ENV=prod    # Apply production changes"
	@echo "  make deploy-prod       # Build images + apply prod"

init: ## Initialize Terraform
	@echo "🔧 Initializing Terraform for $(ENV) environment..."
	cd environments/$(ENV) && terraform init

plan: ## Show what changes Terraform will make
	@echo "📋 Planning changes for $(ENV) environment..."
	cd environments/$(ENV) && terraform plan

apply: ## Apply Terraform configuration
	@echo "🚀 Applying configuration to $(ENV) environment..."
	cd environments/$(ENV) && terraform apply

apply-auto: ## Apply without confirmation prompt
	@echo "🚀 Auto-applying configuration to $(ENV) environment..."
	cd environments/$(ENV) && terraform apply -auto-approve

destroy: ## Destroy all Terraform-managed infrastructure
	@echo "⚠️  WARNING: This will destroy all infrastructure in $(ENV)!"
	@read -p "Are you sure? [y/N] " -n 1 -r; \
	echo; \
	if [[ $$REPLY =~ ^[Yy]$$ ]]; then \
		cd environments/$(ENV) && terraform destroy; \
	fi

format: ## Format Terraform files
	@echo "✨ Formatting Terraform files..."
	terraform fmt -recursive .

validate: ## Validate Terraform configuration
	@echo "✅ Validating Terraform configuration..."
	cd environments/$(ENV) && terraform validate

output: ## Show Terraform outputs
	@echo "📊 Terraform outputs for $(ENV):"
	cd environments/$(ENV) && terraform output

show: ## Show current Terraform state
	@echo "📋 Current state for $(ENV):"
	cd environments/$(ENV) && terraform show

graph: ## Generate dependency graph
	@echo "📈 Generating dependency graph..."
	cd environments/$(ENV) && terraform graph | dot -Tpng > terraform-graph.png
	@echo "Graph saved to environments/$(ENV)/terraform-graph.png"

clean: ## Clean Terraform cache and state backups
	@echo "🧹 Cleaning Terraform cache..."
	find . -type d -name ".terraform" -exec rm -rf {} + 2>/dev/null || true
	find . -type f -name "*.tfstate.backup" -delete
	find . -type f -name ".terraform.lock.hcl" -delete
	@echo "✅ Cleaned"

upgrade: ## Upgrade Terraform providers
	@echo "⬆️  Upgrading providers for $(ENV)..."
	cd environments/$(ENV) && terraform init -upgrade

refresh: ## Refresh Terraform state
	@echo "🔄 Refreshing state for $(ENV)..."
	cd environments/$(ENV) && terraform apply -refresh-only

import: ## Import existing resource (usage: make import RESOURCE=module.example.google_resource.name ID=resource-id)
	@if [ -z "$(RESOURCE)" ] || [ -z "$(ID)" ]; then \
		echo "❌ Usage: make import RESOURCE=<terraform_resource> ID=<gcp_resource_id>"; \
		exit 1; \
	fi
	@echo "📥 Importing $(RESOURCE) with ID $(ID)..."
	cd environments/$(ENV) && terraform import $(RESOURCE) $(ID)

state-list: ## List all resources in Terraform state
	@echo "📋 Resources in $(ENV) state:"
	cd environments/$(ENV) && terraform state list

state-show: ## Show details of a specific resource (usage: make state-show RESOURCE=module.example.google_resource.name)
	@if [ -z "$(RESOURCE)" ]; then \
		echo "❌ Usage: make state-show RESOURCE=<terraform_resource>"; \
		exit 1; \
	fi
	cd environments/$(ENV) && terraform state show $(RESOURCE)

workspace-list: ## List all workspaces
	@echo "📁 Terraform workspaces:"
	cd environments/$(ENV) && terraform workspace list

workspace-new: ## Create new workspace (usage: make workspace-new NAME=workspace-name)
	@if [ -z "$(NAME)" ]; then \
		echo "❌ Usage: make workspace-new NAME=<workspace-name>"; \
		exit 1; \
	fi
	@echo "➕ Creating workspace $(NAME)..."
	cd environments/$(ENV) && terraform workspace new $(NAME)

workspace-select: ## Select workspace (usage: make workspace-select NAME=workspace-name)
	@if [ -z "$(NAME)" ]; then \
		echo "❌ Usage: make workspace-select NAME=<workspace-name>"; \
		exit 1; \
	fi
	@echo "🔀 Switching to workspace $(NAME)..."
	cd environments/$(ENV) && terraform workspace select $(NAME)

check: format validate ## Format and validate configuration

deploy-prod: ## Build all images and deploy to prod
	@echo "🚀 Building and deploying to PROD environment..."
	$(MAKE) build-images
	$(MAKE) apply-auto ENV=prod

build-images: ## Build and push all Docker images
	@echo "🔨 Building all Docker images..."
	cd ../services/stock-price-ingestion && ./docker-build-push.sh
	@echo "TODO: Add build scripts for other services"
	@echo "  - short-data-sync"
	@echo "  - shorts"
	@echo "  - cms"

deploy-image: ## Build and push Docker image, then deploy (backward compat)
	@echo "🔄 Full deployment workflow for $(ENV)..."
	$(MAKE) build-images
	$(MAKE) apply-auto ENV=$(ENV)

logs-stock-price: ## View stock price ingestion service logs
	@gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=stock-price-ingestion" --limit 50 --project=$(GCP_PROJECT_ID)

logs-shorts: ## View shorts API service logs
	@gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=shorts" --limit 50 --project=$(GCP_PROJECT_ID)

logs-short-sync: ## View short data sync job logs
	@gcloud logging read "resource.type=cloud_run_job AND resource.labels.job_name=short-data-sync" --limit 50 --project=$(GCP_PROJECT_ID)

logs-cms: ## View CMS service logs
	@gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=cms" --limit 50 --project=$(GCP_PROJECT_ID)

services: ## List all deployed services
	@echo "📊 Deployed Services:"
	@gcloud run services list --project=$(GCP_PROJECT_ID) --region=australia-southeast2
	@echo ""
	@echo "📦 Cloud Run Jobs:"
	@gcloud run jobs list --project=$(GCP_PROJECT_ID) --region=australia-southeast2

scheduler: ## List all scheduler jobs
	@echo "⏰ Cloud Scheduler Jobs:"
	@gcloud scheduler jobs list --project=$(GCP_PROJECT_ID) --location=australia-southeast2

trigger-stock-sync: ## Manually trigger stock price daily sync
	@echo "🚀 Triggering stock price daily sync..."
	@gcloud scheduler jobs run stock-price-ingestion-daily-sync --location=australia-southeast2 --project=$(GCP_PROJECT_ID)

trigger-short-sync: ## Manually trigger short data sync job
	@echo "🚀 Triggering short data sync job..."
	@gcloud run jobs execute short-data-sync --region=australia-southeast2 --project=$(GCP_PROJECT_ID)

urls: ## Show all service URLs
	@cd environments/$(ENV) && terraform output | grep url

setup: init ## Initial setup (run this first)
	@echo "✅ Terraform setup complete!"
	@echo ""
	@echo "Next steps:"
	@echo "  1. Review configuration: make plan"
	@echo "  2. Apply changes: make apply"
	@echo "  3. View outputs: make output"

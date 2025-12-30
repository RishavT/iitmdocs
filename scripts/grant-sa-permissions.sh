#!/bin/bash
# Grant Cloud Build service account permissions for IITM Chatbot deployment
#
# Required environment variables:
#   PROJECT_ID  - GCP project ID
#   SA_EMAIL    - Service account email (e.g., my-sa@project.iam.gserviceaccount.com)
#   MODE        - "full" for initial setup, "deploy_only" for subsequent deployments
#
# Usage:
#   PROJECT_ID=my-project SA_EMAIL=my-sa@my-project.iam.gserviceaccount.com MODE=full ./grant-sa-permissions.sh

set -e

# Validate required environment variables
if [ -z "$PROJECT_ID" ]; then
  echo "ERROR: PROJECT_ID environment variable is required"
  exit 1
fi

if [ -z "$SA_EMAIL" ]; then
  echo "ERROR: SA_EMAIL environment variable is required"
  exit 1
fi

if [ -z "$MODE" ]; then
  echo "ERROR: MODE environment variable is required (full or deploy_only)"
  exit 1
fi

if [ "$MODE" != "full" ] && [ "$MODE" != "deploy_only" ]; then
  echo "ERROR: MODE must be 'full' or 'deploy_only'"
  exit 1
fi

echo "=== IITM Chatbot SA Permission Setup ==="
echo "Project: $PROJECT_ID"
echo "Service Account: $SA_EMAIL"
echo "Mode: $MODE"
echo ""

# Define permissions for deploy-only role
DEPLOY_PERMISSIONS="\
compute.instances.get,\
vpcaccess.connectors.get,\
storage.buckets.get,\
storage.objects.get,\
storage.objects.list,\
storage.objects.create,\
storage.objects.delete,\
run.jobs.get,\
run.jobs.create,\
run.jobs.update,\
run.jobs.run,\
run.executions.get,\
run.services.get,\
run.services.create,\
run.services.update,\
run.services.setIamPolicy,\
artifactregistry.repositories.get,\
artifactregistry.repositories.uploadArtifacts,\
artifactregistry.repositories.downloadArtifacts,\
logging.logEntries.list,\
logging.logEntries.create,\
iam.serviceAccounts.actAs,\
compute.firewalls.get,\
compute.firewalls.create,\
compute.firewalls.delete,\
compute.networks.updatePolicy,\
logging.sinks.get,\
bigquery.datasets.get"

# Additional permissions for full setup
FULL_EXTRA_PERMISSIONS="\
bigquery.datasets.create,\
logging.sinks.create,\
resourcemanager.projects.getIamPolicy,\
resourcemanager.projects.setIamPolicy,\
vpcaccess.connectors.create,\
compute.instances.create,\
compute.instances.setMetadata,\
compute.instances.setTags,\
compute.instances.setServiceAccount,\
compute.disks.create,\
compute.subnetworks.use,\
compute.networks.access"

if [ "$MODE" = "full" ]; then
  ROLE_ID="iitmChatbotInitialSetup"
  ROLE_TITLE="IITM Chatbot Initial Setup"
  ROLE_DESC="Full permissions for first-time deployment including infra creation"
  PERMISSIONS="${FULL_EXTRA_PERMISSIONS},${DEPLOY_PERMISSIONS}"
else
  ROLE_ID="iitmChatbotDeploy"
  ROLE_TITLE="IITM Chatbot Deploy"
  ROLE_DESC="Minimal permissions for subsequent deployments (Cloud Run + optional embedding)"
  PERMISSIONS="$DEPLOY_PERMISSIONS"
fi

echo "Creating/updating custom role: $ROLE_ID"

# Check if role exists
if gcloud iam roles describe "$ROLE_ID" --project="$PROJECT_ID" &>/dev/null; then
  echo "Role exists, updating..."
  gcloud iam roles update "$ROLE_ID" \
    --project="$PROJECT_ID" \
    --permissions="$PERMISSIONS" \
    --quiet
else
  echo "Creating new role..."
  gcloud iam roles create "$ROLE_ID" \
    --project="$PROJECT_ID" \
    --title="$ROLE_TITLE" \
    --description="$ROLE_DESC" \
    --permissions="$PERMISSIONS"
fi

echo ""
echo "Removing any existing binding for this role..."

# Remove existing binding first to prevent duplicates (ignore errors if binding doesn't exist)
gcloud projects remove-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$SA_EMAIL" \
  --role="projects/$PROJECT_ID/roles/$ROLE_ID" \
  --all \
  --quiet 2>/dev/null || true

echo "Assigning role to service account..."

if [ "$MODE" = "full" ]; then
  # Calculate expiry time (30 minutes from now)
  EXPIRY_TIME=$(date -u -d "+30 minutes" '+%Y-%m-%dT%H:%M:%SZ')
  echo "Full permissions will expire at: $EXPIRY_TIME (30 minutes from now)"

  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:$SA_EMAIL" \
    --role="projects/$PROJECT_ID/roles/$ROLE_ID" \
    --condition="expression=request.time < timestamp('$EXPIRY_TIME'),title=initial_setup_expires_30min,description=Temporary full permissions for initial setup" \
    --quiet
else
  # Deploy-only role has no expiry
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:$SA_EMAIL" \
    --role="projects/$PROJECT_ID/roles/$ROLE_ID" \
    --condition=None \
    --quiet
fi

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Service account $SA_EMAIL now has the '$ROLE_ID' role."
echo ""

if [ "$MODE" = "full" ]; then
  echo "IMPORTANT: Full permissions will automatically expire at $EXPIRY_TIME (30 minutes)."
  echo ""
  echo "Make sure to run your initial Cloud Build within this time window!"
  echo ""
  echo "After initial deployment succeeds, grant permanent deploy-only permissions:"
  echo ""
  echo "  MODE=deploy_only PROJECT_ID=$PROJECT_ID SA_EMAIL=$SA_EMAIL ./scripts/grant-sa-permissions.sh"
else
  echo "Deploy-only permissions are permanent (no expiry)."
fi

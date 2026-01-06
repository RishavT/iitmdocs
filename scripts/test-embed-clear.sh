#!/bin/bash
# Test script for embedding with CLEAR_DB default behavior
#
# This script verifies that:
# 1. Default behavior clears existing embeddings before re-embedding
# 2. Deleted files are removed from the database after re-embedding
#
# Usage:
#   ./scripts/test-embed-clear.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
TEST_FILE="src/faq_24.md"
WEAVIATE_URL="${WEAVIATE_URL:-http://localhost:8080}"

cd "$PROJECT_DIR"

echo "=== Testing CLEAR_DB Default Behavior ==="
echo "Project: $PROJECT_DIR"
echo "Weaviate: $WEAVIATE_URL"
echo ""

# Helper function to count documents in Weaviate
count_document() {
  local filename="$1"
  curl -s "$WEAVIATE_URL/v1/graphql" \
    -H "Content-Type: application/json" \
    -d "{\"query\": \"{ Get { Document(where: {path: [\\\"filename\\\"], operator: Equal, valueText: \\\"$filename\\\"}) { filename } } }\"}" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('data',{}).get('Get',{}).get('Document',[])))"
}

# Step 1: Verify test file exists
echo "Step 1: Checking test file exists..."
if [ ! -f "$TEST_FILE" ]; then
  echo "ERROR: Test file $TEST_FILE not found"
  exit 1
fi
echo "  ✓ $TEST_FILE exists"
echo ""

# Step 2: Run initial embedding to ensure file is in database
echo "Step 2: Running initial embedding..."
docker compose --profile local --profile embed run --rm embed > /dev/null 2>&1
INITIAL_COUNT=$(count_document "faq_24.md")
echo "  ✓ Initial embedding complete"
echo "  ✓ faq_24.md in database: $INITIAL_COUNT document(s)"
echo ""

# Step 3: Remove test file (don't commit)
echo "Step 3: Removing test file temporarily..."
rm "$TEST_FILE"
echo "  ✓ $TEST_FILE removed"
echo ""

# Step 4: Run embedding without flags (default CLEAR_DB=true)
echo "Step 4: Running embedding with default CLEAR_DB=true..."
docker compose --profile local --profile embed run --rm embed > /dev/null 2>&1
echo "  ✓ Embedding complete"
echo ""

# Step 5: Verify file is NOT in database
echo "Step 5: Verifying file is NOT in database..."
AFTER_DELETE_COUNT=$(count_document "faq_24.md")
if [ "$AFTER_DELETE_COUNT" -eq "0" ]; then
  echo "  ✓ PASS: faq_24.md not found in database (count: $AFTER_DELETE_COUNT)"
else
  echo "  ✗ FAIL: faq_24.md still in database (count: $AFTER_DELETE_COUNT)"
  git checkout "$TEST_FILE" 2>/dev/null || true
  exit 1
fi
echo ""

# Step 6: Restore file from git
echo "Step 6: Restoring test file..."
git checkout "$TEST_FILE"
echo "  ✓ $TEST_FILE restored"
echo ""

# Step 7: Run embedding again
echo "Step 7: Running embedding to re-add file..."
docker compose --profile local --profile embed run --rm embed > /dev/null 2>&1
echo "  ✓ Embedding complete"
echo ""

# Step 8: Verify file is back in database
echo "Step 8: Verifying file is back in database..."
FINAL_COUNT=$(count_document "faq_24.md")
if [ "$FINAL_COUNT" -gt "0" ]; then
  echo "  ✓ PASS: faq_24.md found in database (count: $FINAL_COUNT)"
else
  echo "  ✗ FAIL: faq_24.md not found in database (count: $FINAL_COUNT)"
  exit 1
fi
echo ""

echo "=== All Tests Passed ==="
echo ""
echo "Summary:"
echo "  - Default CLEAR_DB=true works correctly"
echo "  - Deleted files are removed from database on re-embed"
echo "  - New/restored files are added to database"

#!/bin/bash
# Custom wrapper: reads prompt from stdin, calls Gemini API, outputs text
set -euo pipefail

MODEL="${GEMINI_MODEL:-gemini-3-pro-preview}"
API_KEY="${GEMINI_API_KEY:-${GOOGLE_API_KEY:-}}"

if [ -z "$API_KEY" ]; then
  echo "ERROR: GEMINI_API_KEY or GOOGLE_API_KEY not set" >&2
  exit 1
fi

PROMPT=$(cat)

PAYLOAD=$(jq -n --arg prompt "$PROMPT" '{
  "contents": [{"parts": [{"text": $prompt}]}],
  "generationConfig": {"temperature": 0.7, "maxOutputTokens": 16384}
}')

RESPONSE=$(curl -s "https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD")

# Extract text from response
echo "$RESPONSE" | jq -r '.candidates[0].content.parts[0].text // "ERROR: no text in response"'

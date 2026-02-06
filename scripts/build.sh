#!/bin/bash
set -e
echo "Building gateway..."
cd packages/gateway && npm run build
echo "Building client..."
cd ../client && npx expo export --platform web
echo "Build complete!"

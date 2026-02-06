#!/bin/bash
set -e
./scripts/build.sh
pm2 restart ecosystem.config.js --env production
echo "Deployed!"

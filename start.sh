#!/usr/bin/env bash
set -euo pipefail

python seed.py data/places.json

exec uvicorn main:app \
  --host 0.0.0.0 \
  --port "${PORT:-8000}"
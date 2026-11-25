#!/usr/bin/env bash
# Verify the specific CTranslate2 Tiny English bundle used for ROOM's acceptance test.
set -euo pipefail

if [[ $# != 1 || ! -d "$1" ]]; then
  echo "Usage: bash backend/scripts/verify-whisper-model.sh MODEL_DIRECTORY" >&2
  exit 2
fi

cd -- "$1"
shopt -s dotglob nullglob
for name in *; do
  case "$name" in
    config.json|model.bin|tokenizer.json|vocabulary.txt) ;;
    *) printf 'Unexpected model directory entry: %s\n' "$name" >&2; exit 1 ;;
  esac
done

for name in config.json model.bin tokenizer.json vocabulary.txt; do
  if [[ ! -f "$name" || -L "$name" ]]; then
    printf 'Expected a regular model file: %s\n' "$name" >&2
    exit 1
  fi
done

# SYSTRAN publishes the model.bin digest for revision 0d3d19a.
# The other digests pin the support files used in the verified bundle.
sha256sum --strict --check <<'SHA256'
14b1b421a90349bc551b881461426b561a874049cb9e4c4864f2ca384f6a7cc5  config.json
1a5afae06a4db91c975c9a9d78be5cc110ee4ea022ad57d55492e4550e936b2a  model.bin
929c5252409436dce1b38a75d1abbcb5e132d170d8e324e4e04ed915fa2d22df  tokenizer.json
ff77588746d3a2595d32ab5b69ffd7b95ce2441ac57533cb66fc3eb575a115cf  vocabulary.txt
SHA256

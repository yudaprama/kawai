#!/usr/bin/env bash
# H7 — K/V budget sweep with peak RSS (macOS /usr/bin/time -l)
# Usage: bash scripts/kv_sweep.sh /path/to/model.litertlm [16384,24576,31999]
# Each budget runs as a separate process so max RSS is isolated.
set -euo pipefail
MODEL="${1:-}"
if [[ -z "$MODEL" ]]; then
  echo "usage: $0 <model.litertlm> [budgets_csv]"
  echo "  budgets default: 16384,24576,31999"
  exit 2
fi
BUDGETS_CSV="${2:-16384,24576,31999}"
IFS=',' read -ra BUDGETS <<< "$BUDGETS_CSV"

echo "# kv_sweep (wrapper) — model: $MODEL budgets: $BUDGETS_CSV"
echo "# each iteration: KAWAI_LLM_MAX_TOKENS=<b> /usr/bin/time -l cargo run --release --example kv_sweep --features litert -- \$MODEL <b>"
echo ""

for b in "${BUDGETS[@]}"; do
  b="$(echo "$b" | xargs)" # trim
  echo "## === budget $b ==="
  # /usr/bin/time -l is macOS-specific; on Linux use /usr/bin/time -v
  if [[ "$(uname)" == "Darwin" ]]; then
    KAWAI_LLM_MAX_TOKENS="$b" /usr/bin/time -l cargo run --release --example kv_sweep --features litert -- "$MODEL" "$b" 2>&1 | tee "/tmp/kv_sweep_${b}.log"
    # Anchored: the example's own banner quotes 'maximum resident set size' —
    # only match /usr/bin/time output lines (spaces + number + label).
    RSS=$(grep -E '^[[:space:]]*[0-9]+[[:space:]]+maximum resident' "/tmp/kv_sweep_${b}.log" | awk '{print $1, $2, $3, $4, $5, $6, $7}' || true)
    echo "# -> $RSS (bytes; /1024/1024 = MB)"
  else
    KAWAI_LLM_MAX_TOKENS="$b" /usr/bin/time -v cargo run --release --example kv_sweep --features litert -- "$MODEL" "$b" 2>&1 | tee "/tmp/kv_sweep_${b}.log"
    grep -i "Maximum resident" "/tmp/kv_sweep_${b}.log" || true
  fi
  echo ""
done

echo "# done — logs in /tmp/kv_sweep_*.log"
echo "# compare 'maximum resident set size' and decode/TTFT across budgets."
echo "# decision: largest budget that stays stable (< ~80% RAM headroom) is the H7 answer."

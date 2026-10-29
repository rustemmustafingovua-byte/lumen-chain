#!/usr/bin/env bash
# Exercise a running devnet: health, stake, swap.
# Usage: scripts/devnet-smoke.sh [base-url]
set -euo pipefail

BASE="${1:-http://127.0.0.1:8899}"
MIN_STAKE="10000000000"
SELL_AMOUNT="1000000"

json_get() {
  node -e 'const fs=require("fs"); const o=JSON.parse(fs.readFileSync(0,"utf8")); const path=process.argv[1].split("."); let v=o; for (const p of path) v=v?.[p]; if (v===undefined) process.exit(2); process.stdout.write(String(v));' "$1"
}

echo "health $BASE/health"
health="$(curl -fsS "$BASE/health")"
echo "$health"
test "$(printf '%s' "$health" | json_get status)" = "ok"

echo "devnet info"
info="$(curl -fsS "$BASE/api/devnet/info")"
echo "$info"
test "$(printf '%s' "$info" | json_get chainId)" = "lumen-devnet"
address="$(printf '%s' "$info" | json_get address)"
stake_before="$(printf '%s' "$info" | json_get stake)"
usdc_before="$(printf '%s' "$info" | json_get usdc)"
test -n "$address"
test "$stake_before" = "$MIN_STAKE"

echo "queue stake"
stake_res="$(curl -fsS -X POST "$BASE/api/devnet/stake" -H 'content-type: application/json' -d "{\"amount\":\"$MIN_STAKE\"}")"
echo "$stake_res"
test "$(printf '%s' "$stake_res" | json_get status)" = "queued"

echo "wait for stake to land in a block"
stake_now="$stake_before"
for _ in $(seq 1 30); do
  stake_now="$(curl -fsS "$BASE/api/devnet/info" | json_get stake)"
  if [ "$stake_now" != "$stake_before" ]; then
    break
  fi
  sleep 1
done
test "$stake_now" != "$stake_before"
echo "stake is now $stake_now"

echo "queue swap sell"
swap_res="$(curl -fsS -X POST "$BASE/api/devnet/swap" -H 'content-type: application/json' -d "{\"direction\":\"sell\",\"amount\":\"$SELL_AMOUNT\"}")"
echo "$swap_res"
test "$(printf '%s' "$swap_res" | json_get status)" = "queued"

echo "wait for USDC balance to increase"
usdc_now="$usdc_before"
for _ in $(seq 1 30); do
  usdc_now="$(curl -fsS "$BASE/api/devnet/info" | json_get usdc)"
  if [ "$usdc_now" != "$usdc_before" ]; then
    break
  fi
  sleep 1
done
test "$usdc_now" != "$usdc_before"
echo "usdc is now $usdc_now"
echo "devnet smoke ok"

#!/usr/bin/env bash

set -Eeuo pipefail

SAMPLE_MIB="${SAMPLE_MIB:-20}"
CHUNK_MIB="${CHUNK_MIB:-1}"
RUNS="${RUNS:-3}"
CONNECT_TIMEOUT_SECONDS="${CONNECT_TIMEOUT_SECONDS:-15}"
MAX_TIME_SECONDS="${MAX_TIME_SECONDS:-300}"
RESOURCE_PATH="${RESOURCE_PATH:-/github/https://github.com/k3s-io/k3s/releases/download/v1.36.4%2Bk3s1/k3s-airgap-images-amd64.tar.zst}"

labels=("ESA" "TEO")
endpoints=("https://proxy-esa.52xckl.cn" "https://proxy-teo.52xckl.cn")

usage() {
  cat <<'EOF'
Usage: bash scripts/benchmark-edge-bandwidth.sh

Continuously downloads one HTTP Range sample through Alibaba Cloud ESA and
Tencent Cloud TEO, then reports throughput for each fixed-size byte window.

Environment variables:
  SAMPLE_MIB                 bytes to sample, in MiB (default: 20)
  CHUNK_MIB                  reporting window, in MiB (default: 1)
  RUNS                       rounds per endpoint (default: 3)
  CONNECT_TIMEOUT_SECONDS    curl connection timeout (default: 15)
  MAX_TIME_SECONDS           curl total timeout per sample (default: 300)
  RESOURCE_PATH              proxy path of a large GitHub release asset
EOF
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_positive_integer() {
  local name="$1"
  local value="$2"
  [[ "$value" =~ ^[1-9][0-9]*$ ]] || die "$name must be a positive integer"
}

cleanup() {
  if [[ -n "${work_dir:-}" && -d "$work_dir" ]]; then
    rm -rf -- "$work_dir"
  fi
}

write_meter() {
  cat > "$meter_file" <<'PY'
import statistics
import sys
import time


def mib_per_second(byte_count, seconds):
    return byte_count / 1024 / 1024 / max(seconds, 1e-9)


chunk_bytes = int(sys.argv[1])
sample_bytes = int(sys.argv[2])
total_bytes = 0
next_boundary = chunk_bytes
last_boundary_bytes = 0
first_byte_at = None
last_boundary_at = None
rates = []

print("window_end_mib\twindow_seconds\twindow_mib_s\twindow_mbit_s\tcumulative_mib_s", flush=True)

while True:
    data = sys.stdin.buffer.read(64 * 1024)
    if not data:
        break

    now = time.monotonic()
    if first_byte_at is None:
        first_byte_at = now
        last_boundary_at = now

    total_bytes += len(data)
    if total_bytes > sample_bytes:
        print("error: server returned more data than the requested Range", file=sys.stderr)
        sys.exit(2)

    while total_bytes >= next_boundary:
        elapsed = now - last_boundary_at
        interval_bytes = next_boundary - last_boundary_bytes
        rate = mib_per_second(interval_bytes, elapsed)
        cumulative_rate = mib_per_second(next_boundary, now - first_byte_at)
        rates.append(rate)
        print(
            f"{next_boundary / 1024 / 1024:.0f}"
            f"\t{elapsed:.3f}"
            f"\t{rate:.3f}"
            f"\t{rate * 8:.3f}"
            f"\t{cumulative_rate:.3f}",
            flush=True,
        )
        last_boundary_at = now
        last_boundary_bytes = next_boundary
        next_boundary += chunk_bytes

if total_bytes != sample_bytes:
    print(
        f"error: received {total_bytes} bytes, expected {sample_bytes} bytes",
        file=sys.stderr,
    )
    sys.exit(2)

if rates:
    first_rates = rates[: min(5, len(rates))]
    last_rates = rates[max(0, len(rates) - 5) :]
    print(
        "summary: "
        f"first_windows_median={statistics.median(first_rates):.3f} MiB/s, "
        f"last_windows_median={statistics.median(last_rates):.3f} MiB/s"
    )

candidate = None
for split in range(3, len(rates) - 2):
    before = statistics.median(rates[split - 3 : split])
    after = statistics.median(rates[split : split + 3])
    if before <= 0:
        continue
    ratio = after / before
    if candidate is None or ratio < candidate[0]:
        candidate = (ratio, split, before, after)

if candidate and candidate[0] <= 0.70:
    ratio, split, before, after = candidate
    boundary_mib = split * chunk_bytes / 1024 / 1024
    print(
        "heuristic: sustained slowdown candidate after approximately "
        f"{boundary_mib:.0f} MiB "
        f"({before:.3f} -> {after:.3f} MiB/s, {ratio * 100:.1f}%)"
    )
else:
    print("heuristic: no sustained drop of 30% or more detected")
PY
}

measure_endpoint() {
  local index="$1"
  local round="$2"
  local label="${labels[$index]}"
  local endpoint="${endpoints[$index]}"
  local url="${endpoint}${RESOURCE_PATH}"
  local header_file="$work_dir/${label}-${round}.headers"
  local curl_log="$work_dir/${label}-${round}.curl.log"
  local sample_bytes=$((SAMPLE_MIB * 1024 * 1024))
  local chunk_bytes=$((CHUNK_MIB * 1024 * 1024))
  local range_end=$((sample_bytes - 1))
  local statuses
  local curl_status
  local meter_status
  local final_status
  local content_range

  printf '\n=== %s round %d ===\n' "$label" "$round"
  printf 'URL: %s\n' "$url"

  set +e
  curl \
    --fail \
    --location \
    --proto '=https' \
    --proto-redir '=https' \
    --silent \
    --show-error \
    --connect-timeout "$CONNECT_TIMEOUT_SECONDS" \
    --max-time "$MAX_TIME_SECONDS" \
    --max-filesize "$sample_bytes" \
    --range "0-${range_end}" \
    --header "Accept: application/octet-stream" \
    --user-agent "proxy-worker-bandwidth-check/1.0" \
    --dump-header "$header_file" \
    --write-out '%{stderr}__CURL_STATS__\t%{http_code}\t%{time_starttransfer}\t%{time_total}\t%{size_download}\t%{speed_download}\t%{url_effective}\n' \
    --output - \
    "$url" \
    2> "$curl_log" | python3 "$meter_file" "$chunk_bytes" "$sample_bytes"
  statuses=("${PIPESTATUS[@]}")
  set -e

  curl_status="${statuses[0]}"
  meter_status="${statuses[1]}"
  final_status="$(awk 'toupper($1) ~ /^HTTP\// { status=$2 } END { print status }' "$header_file")"
  content_range="$(awk 'tolower($1) == "content-range:" { sub(/^[^:]+:[[:space:]]*/, ""); value=$0 } END { gsub(/\r/, "", value); print value }' "$header_file")"

  awk -F '\t' '$1 == "__CURL_STATS__" {
    printf "curl: status=%s, ttfb=%ss, total=%ss, bytes=%s, average=%s bytes/s\n", $2, $3, $4, $5, $6
    printf "effective_url: %s\n", $7
  }' "$curl_log"
  printf 'response: status=%s, content-range=%s\n' "${final_status:-unknown}" "${content_range:-missing}"
  awk '
    toupper($1) ~ /^HTTP\// {
      for (key in values) {
        delete values[key]
      }
      next
    }
    {
      name=tolower($1)
      if (name ~ /^(age:|cache-control:|cf-cache-status:|server:|via:|x-cache:|x-cache-lookup:|x-cache-status:)$/) {
        line=$0
        gsub(/\r/, "", line)
        values[name]=line
      }
    }
    END {
      for (key in values) {
        print "response-header: " values[key]
      }
    }
  ' "$header_file"

  if ((curl_status != 0 || meter_status != 0)); then
    sed '/^__CURL_STATS__/d' "$curl_log" >&2
    die "$label round $round failed (curl=$curl_status, meter=$meter_status)"
  fi

  if [[ "$final_status" != "206" ]]; then
    die "$label round $round did not return HTTP 206; continuous Range measurement is invalid"
  fi
  if [[ "$content_range" != "bytes 0-${range_end}/"* ]]; then
    die "$label round $round returned an unexpected Content-Range: ${content_range:-missing}"
  fi
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi
[[ $# -eq 0 ]] || die "unknown argument: $1"

for command_name in curl python3 awk sed mktemp; do
  command -v "$command_name" >/dev/null 2>&1 || die "required command not found: $command_name"
done

require_positive_integer "SAMPLE_MIB" "$SAMPLE_MIB"
require_positive_integer "CHUNK_MIB" "$CHUNK_MIB"
require_positive_integer "RUNS" "$RUNS"
require_positive_integer "CONNECT_TIMEOUT_SECONDS" "$CONNECT_TIMEOUT_SECONDS"
require_positive_integer "MAX_TIME_SECONDS" "$MAX_TIME_SECONDS"
((CHUNK_MIB <= SAMPLE_MIB)) || die "CHUNK_MIB must not exceed SAMPLE_MIB"
((SAMPLE_MIB % CHUNK_MIB == 0)) || die "SAMPLE_MIB must be divisible by CHUNK_MIB"
[[ "$RESOURCE_PATH" == /* ]] || die "RESOURCE_PATH must start with /"

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/proxy-bandwidth.XXXXXX")"
meter_file="$work_dir/meter.py"
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
write_meter

printf 'Resource: %s\n' "$RESOURCE_PATH"
printf 'Sample: %s MiB, window: %s MiB, rounds: %s\n' "$SAMPLE_MIB" "$CHUNK_MIB" "$RUNS"
printf 'Rates exclude time to first byte; curl statistics report TTFB separately.\n'

for ((round = 1; round <= RUNS; round++)); do
  if ((round % 2 == 1)); then
    measure_endpoint 0 "$round"
    measure_endpoint 1 "$round"
  else
    measure_endpoint 1 "$round"
    measure_endpoint 0 "$round"
  fi
done

printf '\nCompleted. Compare the repeated per-window rates; do not treat one heuristic result as proof of provider throttling.\n'

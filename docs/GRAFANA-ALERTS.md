# Grafana Cloud alerts for kawai (production)

Stack `giganticgecko512`. Create each rule in **Alerting → Alert rules → New
alert rule**; set evaluation interval **1m** and pending period **5m** (2m for
the storm rule). Route via a contact point you configure once under
**Alerting → Contact points**. Every query below is pasted verbatim into the
rule's query editor; run it in **Explore** first to confirm it returns data
(or an empty frame for the silence alerts).

Label facts (see `crates/foundation/telemetry/src/loki.rs`): Loki streams
carry `service="kawai"`, `environment` (`dev` for debug builds,
`production` for release), `level`, `os`, `app_version`, `user_id`
(pseudo-id where callers are disciplined). Prometheus names are the OTLP
encodings — dots become underscores, counters gain `_total`; the UTF-8
dotted form in quotes also queries (same as TROUBLESHOT.md §2).

## 1. Generation export failed — billing loss (CRITICAL)

```logql
sum(count_over_time({service="kawai", environment="production"} |= "export failed" [10m])) > 0
```

The ingest client retries 3× with backoff; this firing means a whole batch
(of up to 25 generations) was dropped after the final attempt — those tokens
are never billed by the recap. Page.

## 2. OTLP credentials missing at startup — billing reads zero (CRITICAL)

```logql
sum(count_over_time({service="kawai"} |= "billing recap will read zero" [10m])) > 0
```

A binary booted without usable OTLP credentials: traces/metrics are DISABLED
for that process's whole lifetime and its cloud spend is invisible to the
recap. One line per offending process start — treat any hit as a page.

## 3. Provider failover storm (WARNING)

```promql
sum by (reason) (increase("kawai.remote.failover"[15m])) > 10
```

`reason` tells you which (`rate_limited`, `server_error`, `client_rejected`,
`transport`, `empty_completion`). Sustained >10/15m means a provider is
unhealthy or keys are exhausted — check the per-provider p95 in TROUBLESHOT
§2 before burning the whole pool.

## 4. Supervisor plan failures (WARNING)

```logql
sum(count_over_time({service="kawai", environment="production"} |= "PlanFailed" [15m])) > 5
```

## 5. Telemetry silence (OPTIONAL — noisy by nature)

```promql
absent_over_time(gen_ai_client_token_usage_total[30m]) == 1
```

A genuinely-idle fleet trips this too. The authoritative pipeline-death
detector is the recap's own ledger compare + empty-window streak
(`crates/ops/recap`, `EMPTY_WINDOWS`) — alert on THAT (cron failure /
empty-window output) and treat this cloud-side rule as a cheap backstop, not
the primary.

## Deliberately not cloud-alertable

- **Unattributed spend** ("generation WITHOUT user attribution") stays a
  local `eprintln!` on purpose — a systematically broken path would flood the
  256-slot Loki channel and starve real errors. Detector: the recap's
  PERHATIAN output.
- **Loki push failures** cannot ship to Loki; silence is the signal (rule 5,
  or a dead-man's-switch on any production stream).

## Baseline dashboards (no alert, keep on a wall)

TROUBLESHOT.md §2 has the working queries: token usage by user/provider,
`histogram_quantile(0.50|0.95, … gen_ai_client_operation_duration_bucket)`,
failover by reason, per-trace Tempo waterfall for slow/empty generations,
gcx for actual prompts/responses.

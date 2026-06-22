# Load Tests

HTTP-focused load tests for EuroBureau using [k6](https://k6.io).

## Install k6

```bash
# Linux (Debian/Ubuntu)
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update
sudo apt-get install k6

# macOS
brew install k6
```

## Run

Default (sequential scenarios, 10-20 VUs each):
```bash
k6 run tests/load/k6-load-test.js
```

Target a specific environment:
```bash
k6 run --env BASE_URL=https://eurobureau.eu tests/load/k6-load-test.js
```

Quick smoke test (fewer VUs, shorter duration):
```bash
k6 run --env BASE_URL=https://eurobureau.eu tests/load/k6-smoke.js
```

## Scenarios

| # | Name | What it tests | VUs |
|---|------|---------------|-----|
| 1 | Login Load | Concurrent authentication | 10 |
| 2 | File Creation | Creating documents under load | 10 |
| 3 | Dashboard Load | Landing page + file listing | 20 |
| 4 | Editor Page | Loading the editor with DS config | 15 |
| 5 | File Download | Concurrent file downloads | 15 |

Scenarios run sequentially (staggered start times) to isolate bottlenecks.

## Thresholds

- 95th percentile response time < 2s
- Error rate < 5%

## Notes

- The setup phase creates 25 test accounts (reused across runs)
- Test files accumulate — clean up periodically via the database
- Run from a machine OUTSIDE Hetzner for realistic latency
- Notify Hetzner support before running heavy tests

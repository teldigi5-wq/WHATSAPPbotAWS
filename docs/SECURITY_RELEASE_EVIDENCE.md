# Security release evidence and review gates

**Scope:** WHATSAPPbotAWS draft PR #3, assessed 26 October 2026. These are candidate code changes, not an authorized merge or deployment.

## Automated checks and defended boundaries

- Transitive body-parser 1.20.9; patched Axios, Sharp, proxy-addr and qs from committed npm lockfile.
- Private QR setup guarded by strong Basic auth; pairing is rate-limited and accepts <=1 KiB uncompressed JSON.
- Protected runtime baseline: Node 24.22.1+ on Amazon Linux 2023, installed via distribution packages, not curl-to-shell.
- EC2 bootstrap explicitly requires the approved 40-character `APPROVED_RELEASE_SHA`, locked `npm ci` and critical/high npm audit; no automatic production deployment.
- Setup script requires a private /data roster, secure environment for `BOT_SETUP_USER` and `BOT_SETUP_PASSWORD`, and localhost pairing admin.

**CI evidence:** https://github.com/teldigi5-wq/WHATSAPPbotAWS/actions/runs/40265117244

To verify that the scan remains valid, use the latest PR-head workflow result; older CI links are historical evidence only. Zero findings from a dependency scan do **not** establish absence of application or infrastructure vulnerabilities.

## Mandatory manual and release checks

- [ ] Run authorized WhatsApp pairing on a private staging number with actual QR and pairing-code paths.
- [ ] Exercise reply, reconnect, audio/image, and group commands; capture redacted logs and no PII.
- [ ] Confirm EC2 port 8080 closed to the public; only SSH/VPN/private HTTPS proxy reaches the local admin listener.
- [ ] Verify reviewed runtime commit SHA, roster mode 0600/0400, session storage and recovery.
- [ ] Inspect current GitHub secret/code/dependency alerts using a repository-owner security dashboard.

## Release decision standard

- Keep the PR draft until required checks on its **exact latest commit** pass.
- Inspect the changed-file diff, ensure `main` is not overwritten, and require an approving reviewer.
- Never push API keys, account credentials, WhatsApp/Telegram session files or production customer data to a test log.
- Sign and publish only after owner approval, preserve reproducible artifacts and a rollback point.
- Label all claims precisely: **CI passed**, **packaged successfully**, **manual test performed**, or **not yet verified**. Never substitute one for another.

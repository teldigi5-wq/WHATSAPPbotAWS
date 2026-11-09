# AI continuation — teldigi5-wq/WHATSAPPbotAWS — 2026-11-09

> Documentation-only review checkpoint. Default `main` and implementation/feature branches are unchanged. This file is on `docs/ai-continuation-20261109`. Verify live GitHub data before trusting this snapshot.

## Current evidence boundary
Repository: https://github.com/teldigi5-wq/WHATSAPPbotAWS
Status observed from the current `main` README on 2026-11-09: SLIIT WhatsApp student-assistance backend; README describes Node/Express/Baileys/PM2 and security-gated private-roster workflows. No live linked device or AWS production runtime was verified in this handoff.
No new code build, physical-device QA, merge, deployment, security certification or owner acceptance was performed by writing this file.

## Next non-repeating milestones
1. Audit current auth and command handlers against protected main
2. reproduce CI and dependency checks
3. validate roster privacy/migration with synthetic fixtures
4. only then conduct owner-approved real device/host acceptance.

## Non-negotiable constraints
Never include student records, QR sessions, session tokens or credentials.
Use local-first/open-source/free tooling where feasible; do not disclose private data, pay for services, change a production environment, force push, merge review-only security code, relax CI, or touch unrelated branches without owner approval.

## Resume steps for another AI/developer
1. Read this note, `README.md`, all applicable `ROADMAP*`, `docs/`, open issues, releases and PRs. Run `gh repo view teldigi5-wq/WHATSAPPbotAWS`, `gh pr list -R teldigi5-wq/WHATSAPPbotAWS --state open --limit 100`, `gh run list -R teldigi5-wq/WHATSAPPbotAWS --limit 20` and `git fetch --all --prune` in an isolated clone.
2. Record `main` SHA, actual PR DAG/base/head SHAs, checks and any warnings. A historic green run is not proof of later code.
3. Mark each claim precisely: **planned**, **coded**, **locally tested**, **independently CI-verified**, **merged**, **deployed**, **operator verified**; do not blend these categories.
4. Start at the next missing evidence or implementation milestone above, not by repeating completed work. Make a minimal reviewable change and record commit, command, observed result, blocker, and rollback.
5. Treat this note as a dated index, not proof that every historic branch was audited or that a release is ready.

## Cross-account continuity
Primary: https://github.com/teldigi5-wq
Education/test mirror: https://github.com/IT26101524
Canonical Aetheris: https://github.com/teldigi5-wq/aetheris-platform
Canonical Runtime: https://github.com/teldigi5-wq/aetheris-ai-runtime

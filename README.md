<div align="center">

# SLIIT WhatsApp Bot · AWS Edition

**Student-assistance messaging backend · Node.js, Express, Baileys and PM2**

[![CI](https://github.com/teldigi5-wq/WHATSAPPbotAWS/actions/workflows/ci.yml/badge.svg)](https://github.com/teldigi5-wq/WHATSAPPbotAWS/actions/workflows/ci.yml)
[Source](https://github.com/teldigi5-wq/WHATSAPPbotAWS) · [Security policy](SECURITY.md) · [Private-roster migration notes](SECURITY_MIGRATION.md) · [Release evidence](docs/SECURITY_RELEASE_EVIDENCE.md)

**Developed and maintained in [Poojana Kaveesh Sellahewa's GitHub account](https://github.com/teldigi5-wq).**

</div>

## Project in one minute

A WhatsApp-linked student assistance bot providing command-driven support for study information, schedules and related student workflows. The repository emphasizes the backend engineering needed around a long-lived chat service: **authentication, command routing, persistent sessions, private roster storage, request bounds and repeatable deployment preparation**.

This is **not** a publicly accessible chatbot SaaS or a claim of currently running AWS infrastructure. The bot requires private student records, an authorized WhatsApp linked device and a correctly configured host. GitHub CI does **not** make a production WhatsApp session available.

| Component | Actual implementation |
| --- | --- |
| Messaging client | Baileys linked-device WhatsApp client |
| Application | Node.js, Express, command handlers in bot.js |
| Administration | Locally bound QR/pairing endpoint with HTTP Basic auth |
| Storage | Private student/group rosters and session state outside Git |
| Operations target | Amazon Linux 2023, PM2, operator-managed EC2 |
| Security tests | Node built-in test runner, pairing and bounded media-response regressions |
| Automated checks | npm lockfile install, syntax and shell checks, source privacy gate, dependency audit |

## System design and trust boundaries

~~~mermaid
flowchart LR
    Student[Authorized WhatsApp user] --> WA[Baileys linked device]
    WA --> Bot[Node.js command and reply handlers]
    Bot --> Roster[Private roster under /data]
    Bot --> State[Private auth and service data]
    Bot --> AI[Optional configured AI provider]
    Admin[Operator over SSH / private HTTPS] --> Guard[Local Basic-auth setup endpoint]
    Guard --> Bot
    CI[GitHub Actions CI] --> Review[Reviewed source and test evidence]
    Review --> Host[Separately managed EC2 / PM2]
~~~

**Key boundaries:**
- Private student and group rosters are **not shipped as public source files**. The bot resolves them from a protected host data directory.
- WhatsApp authentication/session data is a credential and must remain outside version control.
- The Express setup interface binds to **127.0.0.1 by default**; only a secure SSH tunnel or independently protected HTTPS proxy should expose operator access.
- Pairing uses a configured administrator credential, an allowed phone number, rate limiting and a **small uncompressed JSON request** to reduce parser abuse.
- Optional AI features depend on configured external credentials; their availability and output quality are not measured by CI.

## What I can demonstrate in an interview

| Topic | Code / evidence | Engineering discussion |
| --- | --- | --- |
| Controlled admin and pairing | [security/setup-access.js](security/setup-access.js), [parser](security/pair-body-parser.js) | Failure-closed auth, constant-time credential comparison, pairing attempts, request inflation disabled |
| Untrusted media responses | [security/media-response.js](security/media-response.js) | Check content type and cap streamed byte counts before storing image data |
| Private student records | [bot.js](bot.js), [migration plan](SECURITY_MIGRATION.md) | Why putting rosters in a public repo or logs is unacceptable |
| Testable boundaries | [tests/](tests/), [CI](.github/workflows/ci.yml) | Test valid and rejected paths without a live WhatsApp connection |
| Reproducible host setup | [setup.sh](setup.sh), [PM2 ecosystem](ecosystem.config.js) | Approved commit gates, locked npm dependencies, runtime requirements and preserved data |
| Security remediation | [PR #3](https://github.com/teldigi5-wq/WHATSAPPbotAWS/pull/3) | Patched body-parser lineage, pairing parser tests and hardened EC2 bootstrap |

**Ownership:** This codebase and its [commit history](https://github.com/teldigi5-wq/WHATSAPPbotAWS/commits/main) are the reviewable evidence of the maintained student assistant. For interviews, explain exactly which areas you designed, implemented, tested or reviewed and acknowledge human collaborators and AI/tools if used. A GitHub account or merged PR does not prove sole human authorship or an external security audit.

## Reproduce tests without a WhatsApp account

Prerequisites: npm and a supported patched Node.js runtime. The package engines allow modern supported Node.js 22 or 24; CI uses **24.22.1**.

~~~bash
git clone https://github.com/teldigi5-wq/WHATSAPPbotAWS.git
cd WHATSAPPbotAWS
npm ci
node --check bot.js
node --check security/setup-access.js
node --check security/media-response.js
bash -n setup.sh
node --test tests/*.test.js
npm audit --omit=dev --audit-level=high
~~~

These are test and validation commands, **not** instructions to run a configured WhatsApp service. The verified October 26, 2026 GitHub CI completed **10 automated tests** and reported **zero known dependency vulnerabilities** at scan time. Review [current CI runs](https://github.com/teldigi5-wq/WHATSAPPbotAWS/actions/workflows/ci.yml) before quoting any status.

### What the tests cover

- Missing, incorrect or valid operator credentials, including fail-closed configuration.
- Pairing rate limit and blocked compressed or over-limit request bodies.
- Bounds on externally returned image content and streamed response size.
- Clean dependency installation and absence of committed private roster files on the tested branch.

They do **not** prove full student-command correctness with real rosters, WhatsApp linking, availability on AWS, or safe handling of every production edge case.

## Project structure

| File / folder | Purpose |
| --- | --- |
| [bot.js](bot.js) | Main messaging, student workflows and Express administration |
| [security/](security/) | Reusable setup/pairing and bounded media response policy |
| [tests/](tests/) | Synthetic security regression tests |
| [ecosystem.config.js](ecosystem.config.js) | PM2 process configuration |
| [setup.sh](setup.sh) | One-time reviewed-host bootstrap |
| [timetable.json](timetable.json) | Non-private timetable data published in the repository |
| [.github/workflows/ci.yml](.github/workflows/ci.yml) | CI on main and pull requests |
| [SECURITY_MIGRATION.md](SECURITY_MIGRATION.md) | Historic private-roster handling and operational prerequisites |

**Historical privacy limitation:** Removing private roster data from the latest source tree does not erase previous Git history, forks or caches. Follow the separate remediation and appropriate privacy-response plan documented in [SECURITY_MIGRATION.md](SECURITY_MIGRATION.md). Never recreate the roster inside a public repo.

## Deployment is a separate operation

**Do not execute the bootstrap until host preparation and privacy checks are complete.** For a future authorized Amazon Linux 2023 deployment, the [setup script](setup.sh) requires:

1. A private, permission-restricted **/data/students.json** and **/data/eac-groups.json** on the host.
2. A securely injected **BOT_SETUP_USER** and a strong **BOT_SETUP_PASSWORD**, plus the pairing phone allowlist.
3. A reviewed, exact 40-character **APPROVED_RELEASE_SHA** matching main.
4. A supported Node.js 24 environment, ability to run locked npm installation and high-severity dependency audit.
5. Secure SSH/firewall/private-access configuration and backed-up WhatsApp state.

The administrator UI defaults to localhost. To access it remotely, use a trusted SSH tunnel; **do not open raw HTTP port 8080 to the public internet**.

### Deployment workflow truth

The repository contains a root-level **deploy.yml** describing an SSH deployment approach. **It is not an active GitHub Actions workflow at that location**: GitHub Actions looks in **.github/workflows/**. The workflows currently under that directory are CI and security regression checks, not proof of an actual EC2 deployment. Do not describe this project as automatically deployed on every push merely because a root-level example exists.

No real server restart, production verification or credential inspection is performed by these README edits.

## Verified versus still to verify

| Demonstrated in source or CI | Manual / real-system gate |
| --- | --- |
| Pairing parser, authentication and media bounds tests | Authorized WhatsApp device linking and full command flow |
| Private-roster absence from current source | Historical Git privacy cleanup and owner response |
| Node 24 clean CI, npm production audit | Amazon Linux package compatibility, host permissions and uptime |
| Syntax checking and PM2 configuration | Actual restart/reconnect, backups and rollback on EC2 |

## Short interview walkthrough

1. Explain the security problem caused by keeping real student data in a public repository.
2. Show a failing pairing authorization test and its protected Express handler.
3. Run the tests with synthetic requests; explain why gzip/oversized pairing bodies are rejected.
4. Trace session storage and why PM2 restarts must not delete it.
5. Be explicit that production EC2/WhatsApp tests are **not completed** in CI.

### Remaining engineering work

- [ ] Complete any necessary historical roster privacy incident response.
- [ ] Validate real authorized student commands and WhatsApp pairing on private staging data.
- [ ] Test host bootstrap, PM2 persistence, backups and rollbacks in an authorized environment.
- [ ] Turn the example deployment configuration into a separately approved, secure workflow if needed.
- [ ] Record sanitized application screenshots and operational runbooks.

**Security reporting:** Follow [SECURITY.md](SECURITY.md). Never attach real rosters, session files, phone numbers, SSH keys or API secrets to public issues.

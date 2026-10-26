# Private roster and bot pairing safety

The private-roster security changes have been merged into the repository's main branch. **This does not prove that an EC2 host was migrated or production data was secured.**
Current-branch student records were removed from the repository, but this **cannot remove public Git history, clones, or cached copies**.
The historical student roster is an exposed data set; handle privacy response/notifications according to relevant obligations.

## Required preparation on the actual bot host (BEFORE deployment)

1. Record the current running commit, back up /data and WhatsApp auth/session files to an encrypted, access-controlled location.
2. While still on the existing checkout, provision a protected directory on the host:
   - Install the existing \`students.json\` as \`/data/students.json\` with file permissions 0600 and directory permissions 0700.
   - Extract the one-line \`const EAC_GROUPS = { ... };\` JSON mapping from the existing \`bot.js\` into \`/data/eac-groups.json\` (a private JSON object, never a repo file). Set file permissions 0600.
   - Verify both JSON files parse correctly and retain the record counts you expect. Do not print records to logs.
   - Ensure the process OS user can read the two files.
3. Set private environment values (never commit them): \`DATA_PATH=/data\`, \`SUPER_ADMIN\`, optional \`SUPER_ADMIN_LIDS\`, \`BOT_SETUP_USER\` (minimum 4 characters), \`BOT_SETUP_PASSWORD\` (at least 20 randomly generated characters), \`WHATSAPP_PAIR_PHONE\` (only the bot number that may be paired).
4. By default the bot listens only on \`127.0.0.1\`. For remote administration, use an SSH tunnel or an HTTPS-authenticated proxy. Do not expose raw HTTP or bind to \`0.0.0.0\` without independent firewall/TLS controls.
5. Test student lookup, registration, EAC groups, messaging, WhatsApp QR login, pairing with the allowed number, and all admin commands on an isolated preview machine.
6. Do not deploy this merged code to a running bot until private-roster migration and smoke tests pass. Roll back to the recorded commit if needed, while keeping the data directory safe.

### Verification

\`\`\`bash
npm ci --ignore-scripts
node --check bot.js
node --test tests/*.test.js
\`\`\`

This code uses Basic authentication only over a loopback or a TLS-terminating trusted proxy. Basic credentials must never traverse unencrypted public transport.

## Required separate incident follow-up
Remove old history references containing student records under a coordinated privacy remediation plan, after backups and clone/fork considerations. Rotating credentials alone does not remove historical PII. Do not force-push or rewrite history automatically.

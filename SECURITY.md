# Security Guidance

This project connects to a real WhatsApp linked-device session and may also use SSH credentials for automated AWS deployment. Treat all authentication material as sensitive.

## Never commit

Do not commit any of the following:

- WhatsApp session/authentication data
- `.pem` or other SSH private keys
- access tokens or API secrets
- `.env` files containing real credentials
- production server addresses or credentials that should remain private
- exported QR/session artifacts

## WhatsApp session data

Linked-device session files can provide access to the connected WhatsApp account. Treat them like passwords.

Runtime authentication data should remain in persistent server storage such as `/data` and outside normal source-control deployment paths.

If a session is exposed, revoke the affected linked device from WhatsApp and create a new session.

## AWS deployment secrets

GitHub Actions deployment credentials should be stored using GitHub Actions Secrets rather than directly in workflow files.

For SSH access:

- use a dedicated key where practical;
- restrict the EC2 security group to trusted source IPs;
- rotate a key immediately if it is exposed;
- avoid logging private key material in workflows or shell output.

## Reporting a problem

Do not post live credentials or session data in a public issue. Remove secrets from logs and screenshots before sharing debugging information.

For production use, add stronger secret management, restricted networking, HTTPS/reverse proxy configuration, monitoring and a documented credential-rotation process.

# Security policy

## Reporting a vulnerability

Please do **not** open a public issue for security problems.

Report vulnerabilities privately through GitHub's **Report a vulnerability** button on this
repository's **Security** tab (private vulnerability reporting). Include what you found, how to
reproduce it, and the impact you expect. You will get an acknowledgement, and a fix or a mitigation
plan once the report is confirmed.

Issues of particular interest: ways to use models without being charged or to exceed a key's credit,
authentication or authorization bypasses (gateway keys, admin sessions, CSRF), exposure of upstream
credentials or gateway keys, and server-side request forgery through upstream or model settings.

## Supported versions

Security fixes are made on the `main` branch.

## Security model

How keys, sessions, credentials and logs are protected is described in
[`docs/SECURITY.md`](./docs/SECURITY.md).

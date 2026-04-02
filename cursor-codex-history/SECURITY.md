# Security Policy

## Supported Versions

Security fixes are applied to the latest code on the default branch.

## Reporting a Vulnerability

Please do **not** open public issues for security vulnerabilities.

Instead:

1. Prepare a minimal report with:
   - impact
   - affected files/commands
   - reproduction steps
   - suggested mitigation (if any)
2. Contact maintainers through a private channel available in your repository hosting platform.
3. If private contact is unavailable, open an issue with **no exploit details**, requesting a private follow-up.

## What to Include

- Environment (OS, Node version)
- Exact command used
- Relevant logs (redact secrets/tokens)
- Whether data loss or privilege escalation is possible

## Response Expectations

- Initial acknowledgment target: within 7 days
- A fix timeline depends on severity and maintainer availability

## Safety Notes for This Project

- This project intentionally avoids writing to Cursor internal DB.
- `delete` requires explicit `--force`.
- Path writes are restricted for exported files.

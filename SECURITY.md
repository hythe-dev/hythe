# Security

## 0.1.2 credential-output issue

Version `0.1.2` could print a generated API-key value during
`init --write-env` and include that value in generated client configuration
snippets. Those values may have been retained in terminal, CI, or agent logs.

The issue is fixed in `0.1.3`. Users who ran the affected command on `0.1.2`
should treat the generated key as potentially exposed, rotate it through their
normal server/client cutover procedure, and upgrade to `0.1.3`.

Do not include credential values in bug reports. Report security issues through
the repository's private security-reporting channel.


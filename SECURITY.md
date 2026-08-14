# Security

## 0.1.4 identity and private-message containment

The 0.1.4 release candidate removes implicit bridge identity defaults, binds
client-lane actions to an explicit exact identity, stops alias-family mailbox
authorization, and prevents historical private message payloads from being
returned through shared graph/search/export and request-log paths. An offline,
dry-run-first migration is included for historical residue; operators must not
execute it while unresolved or ambiguous rows are reported.

HYTHE's shared API key remains a deployment/tenant credential. It does not yet
prove a distinct agent principal to the server, so holders of that credential
are trusted operators and can bypass client-side bridge checks with raw
protocol calls. Do not expose the server or shared key to mutually untrusted
agents. Per-agent server-side credentials and mandatory principal binding are a
separate hardening phase.

## 0.1.2 credential-output issue

Version `0.1.2` could print a generated API-key value during
`init --write-env` and include that value in generated client configuration
snippets. Those values may have been retained in terminal, CI, or agent logs.

The issue is fixed in `0.1.3`. Users who ran the affected command on `0.1.2`
should treat the generated key as potentially exposed, rotate it through their
normal server/client cutover procedure, and upgrade to `0.1.3`.

Do not include credential values in bug reports. Report security issues through
the repository's private security-reporting channel.

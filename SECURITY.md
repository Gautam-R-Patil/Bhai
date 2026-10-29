# Security Policy

Bhai is proprietary software of TRUSCOR Private Limited. This repository is
private; access is limited to TRUSCOR staff.

## Report a vulnerability

Tell a TRUSCOR maintainer privately, or open an issue in this repository labelled
`area: security` if the details are safe to share with everyone who has access.
Never paste secrets, tokens, customer data, or working exploits into an issue or
pull request.

Include the affected commit or version, platform, reproduction steps, and impact.

## Handling secrets

- LLM and provider keys live only in the Convex environment. The client never
  holds them; it reaches the LLM proxy over ECDH P-256 + AES-256-GCM.
- `.env`, `data/`, and signing material are gitignored. Keep GitHub secret scanning
  with push protection on for this repository, so a push containing a detected
  secret is refused.
- If a secret is committed anyway, rotate it first, then remove it from history.

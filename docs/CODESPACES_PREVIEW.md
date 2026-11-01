# Private HON OS preview

Use the [owner interactive preview guide](OWNER_INTERACTIVE_PREVIEW.md) on `codex/private-interactive-preview`.

[PR #51](https://github.com/myhonosai/honos/pull/51) was reviewed as the original reference-only setup. It remains unchanged and unmerged. Its historical command displays public design references; it cannot provide persistent interactive authorized fixture workflows and predates the merged production-startup guard. Do not use that old command to bypass current authentication. This isolated branch supplies the explicit synthetic launcher needed for protected screens, preserving the actual Next.js application and normal authentication code.

No Codespace or HTTPS URL has been provisioned by Codex. GitHub Private forwarding and signed-out denial must be verified in the owner's actual Codespace. Automated localhost browser evidence is a different boundary.

# Repository scope

This is the independent DLSS5 Manager repository only. Do not read, copy, modify or infer the private rendering implementation, unpublished runtime artifacts, internal paths or protected component source. The manager depends only on the public versioned file/package contract in docs/PACKAGE-CONTRACT.md.

Never add private source, unpublished addons/runtime DLLs, game contents, user paths, credentials or signing private keys to this repository or public artifacts. Authorized release binaries may be explicitly staged by the publisher through the distribution contract; do not fetch them from private research repositories. The default public build contains no NR binaries. Tests use synthetic files and never execute them. Keep fixture output under ignored test-results; application release files are explicitly allowlisted.

Safety gates, original-file backups, hash verification and journaled recovery must not be bypassed to make a test or UI look successful. No anti-cheat workarounds or unknown graphics-proxy replacement. The sole fresh loader deployment exception is the fixed official ReShade hash, after checking that no conflicting loader exists; it shares the addon transaction and recovery. Unknown ownership is preserved and requires explicit review. Source identity, integrity and actual game compatibility must be reported separately.

Validate modifications with npm run check, npm test and npm run test:ui. Windows builds also run scripts/release-files.cjs and scripts/test-installer.ps1. Do not label synthetic-file tests as real-game rendering tests. Keep compatibility matrix and release limitations accurate.

Use Chinese, player-first action labels. No manual API/hash/version forms in the normal flow. Compatibility advisories (online/anti-cheat/untouched unknown proxies) require concise disclosure rather than blanket blocking. Write locks, integrity drift and unsafe overwrites remain hard failures. Keep Bilibili entry at https://space.bilibili.com/941799. External navigation must remain allowlisted. Do not introduce renderer filesystem access or a generic IPC bridge.

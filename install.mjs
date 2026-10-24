#!/usr/bin/env node
// This fork intentionally retires the shared-directory legacy installer.
// In particular, --remove must never delete an upstream installation.
console.error(`@raviy06/pi-subagents uses Pi's package manager, not the legacy installer.

Use: pi install npm:@raviy06/pi-subagents
For an unpublished local build: pi install /absolute/path/to/dist-pkg

First disable/remove the configured upstream pi-subagents package explicitly.
Never load upstream and the fork together. See docs/fork-maintenance.md.
No files or configuration were changed.`);
process.exitCode = 1;

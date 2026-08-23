# Retained public core retirement

## Current state

`app/backend/bizhub` is retained in the repository because CP-5 was not
authorized to delete the previous public implementation. The `v0.7` Dockerfile
does not copy it, the delivery adapter does not import it, and distribution tests
hold that boundary. It is therefore historical/rollback source, not an active
second runtime.

The immutable stable `v0.3.0` tag and image contract remain unchanged. A new
preview failure falls back to that fixed stable release; it does not require
rewriting or deleting stable history.

## Conditions before deletion

Deleting the retained directory requires a separate approved change after all
of the following are true:

1. the fixed common-artifact preview is published and its disposable Ubuntu
   release workflow passes;
2. no current Dockerfile, installer, test, plugin, MCP, checksum input, or
   documentation entry imports or copies the directory;
3. the preview rollback window and evidence-retention decision are complete;
4. the stable tag remains reproducible from Git history;
5. the project Owner approves the exact deletion diff and recovery plan.

Until then, fixes to Generic business behavior belong in the canonical common
source, not in this retained directory. No new feature or writer may be added
there.

# BizHub shared Agent contract

This is the shared guidance source for the existing `bizhub-core` plugin and
customer-private extensions. It is guidance, not permission or a claim that a
particular release implements a capability. Read the selected instance's
current contracts and advertised tools before acting.

## Scope and authority

- Use the smallest existing configuration, mapping, workflow or module that
  solves the task. Keep one formal Owner and one physical writer per business
  fact; an Agent, Skill, MCP adapter or page does not become another writer.
- Read bounded current evidence before drawing a conclusion. History, memory,
  a healthy process, a model answer and an action plan are not formal readback.
- Business changes use the existing Owner's typed preview, required approval,
  apply and readback. Apply the same approved objects and command/hash; changed
  state or scope requires a fresh preview. Read-only SQL is evidence only;
  never use direct business SQL or an alternate writer to bypass a rejection.
- Reuse authorization already granted for the same scope. A tool being
  available, a preview passing, or a successful test grants no additional
  authority. Follow the active release's explicit approval contract; a private
  automation policy does not authorize another customer or instance.
- Keep credentials, customer exports and mutable production facts out of
  Skills, public repositories, logs and chat. Use the approved credential
  mechanism without asking the user to disclose secrets in conversation.

## Customer boundary

- Shared guidance contains no customer names, host paths, private endpoints,
  seed data, customer formulas or assumed business stages. Customer variations
  stay in configuration, mappings or a customer-private extension. A reusable
  capability belongs in the common layer from the start; a second live customer
  is not required.
- A private Skill adds only its workflow and instance-specific references.
  It cannot override authentication, Owner, approval, audit or readback. It
  calls that instance's existing interface instead of registering a duplicate
  generic Skill or MCP merely to reuse this document.
- Maintain common rules here and link to them. Private consumers pin an
  immutable public commit and update that reference after review; do not keep a
  separately editable copy or silently follow a moving branch. Reading this
  document does not invoke the public bootstrap or install another server.

## Changes and completion

- Preserve unrelated work. Keep changes scoped and reversible, reuse existing
  implementations, and remove the directly superseded path when replacing it.
- Verify the affected behavior and permission boundary through the existing
  entrypoints. Reuse green coverage for unchanged source and dependencies;
  wording-only changes need reference/content checks, not an application
  release or full suite. Update only the authority for the changed fact.
- Report source changes, checks, deployment and business acceptance separately.
  Claim an outcome only after its formal readback; state what was not checked.
  Clean up only task-owned, inactive temporary artifacts, preserving shared
  dependencies, user changes and business evidence.

## Plugin and Skill delivery

An authorized shared-rule or customer-Skill edit includes delivery to the
task's configured consuming hosts, whether Claude, Codex or another Agent
does the work. Follow the existing repository release contract through merge
and checks, update the affected private consumer's immutable reference when
shared guidance changes, and finish the host-native plugin update, reload and
version/content readback in the same task without another reminder.

Use the repository's existing version policy and native host commands. Verify
the installed package against the published source, the loaded Skill paths,
and any pinned shared reference. A reference-only consumer updates its private
plugin; it does not install another bootstrap or MCP. Do not update unrelated
customers or invent a separate updater, hook, test or gate for this workflow.

A commit, successful CI, installed version or fresh discovery process alone
does not prove that a running conversation has read new instructions. Reload
through the host's supported mechanism and explicitly reread changed Skills
and references in the current conversation. Reconnect changed tool definitions
before using them. Report an unavailable reload or failed readback as unfinished
delivery, rather than claiming automatic hot reload or asking the user to
remember to finish it later.

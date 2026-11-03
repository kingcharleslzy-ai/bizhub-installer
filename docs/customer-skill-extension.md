# Customer Skill extension guide

This is documentation, not an installed Skill.

Common safety and authority rules live in the existing plugin's
[shared Agent contract](../plugins/bizhub-core/skills/bizhub-bootstrap/references/agent-contract.md).
Customer Skills reference that file at a reviewed immutable public commit,
then add only private workflow instructions. Do not copy its text or install
the public bootstrap/MCP alongside an existing customer interface just to read
the contract. If the pinned source cannot be read, report the missing reference
before an action that relies on it; do not substitute a moving branch.

Read [Customer Agent evolution](agent-evolution.md) first. Most differences
should remain configuration or a source mapping; a Skill is the third level,
not the default response to customization.

After the base BizHub handoff is complete, a customer's own Agent may add one
small customer-specific Skill when a workflow is repeated often enough to
justify it. Start with documentation and MCP tools; do not create a Skill for
every form, data source, or one-off request.

Keep each customer Skill:

- owned and reviewed by that customer;
- namespaced for the customer and one clear purpose;
- inactive until the customer approves it;
- limited to documented MCP tools and server-side permissions under the shared
  Agent contract.

The Agent evolves reviewed source in the customer's private repository. It
must never treat a running production instance as a self-modifying workspace.

Before adding another Skill, check whether the existing Skill can remain short
and unambiguous. Remove or merge overlapping instructions rather than loading
conflicting Skills.

# Customer Skill extension guide

This is documentation, not an installed Skill.

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
- limited to documented MCP tools and server-side permissions;
- unable to override BizHub's authentication, Owner, approval, audit, or
  readback boundaries.

The Agent evolves reviewed source in the customer's private repository. It
must never treat a running production instance as a self-modifying workspace.

Before adding another Skill, check whether the existing Skill can remain short
and unambiguous. Remove or merge overlapping instructions rather than loading
conflicting Skills.

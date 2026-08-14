# BizHub Installer

Agent-first bootstrap for setting up a private BizHub instance.

> **Current status: preview / read-only.** This repository does not yet install
> a production backend, deploy a production frontend, or ingest real customer
> data. It provides one small MCP server and one bootstrap Skill so an Agent can
> identify the project, explain the boundary, and ask the first setup questions.

## Give this repository to an Agent

Send the Agent this pinned release URL:

`https://github.com/kingcharleslzy-ai/bizhub-installer/tree/v0.1.0-preview.1`

Ask it to:

1. read `AGENTS.md` and `install/bootstrap.yaml` without running repository code;
2. show you the preview limitations and the host changes it proposes;
3. get your approval before installing the plugin or registering the MCP server;
4. load exactly one `bizhub-bootstrap` Skill and one `bizhub-mcp` server;
5. begin with the deployment questions.

Do not paste passwords, API keys, cookies, private keys, or database files into
chat. The preview does not need them.

## Included

- `plugins/bizhub-core`: a Codex-compatible plugin package.
- `bizhub-mcp`: a dependency-free, read-only stdio MCP server.
- `bizhub-bootstrap`: the only BizHub-managed Skill in this repository.
- `docs/customer-skill-extension.md`: guidance for a customer's own Agent to
  add a small project-specific Skill later, only when a repeated workflow
  justifies it.

## Preview installation

Use a trusted host-native plugin installer with the pinned release above and
select `plugins/bizhub-core`. If the host does not support plugins, it may
register the single server described in
`plugins/bizhub-core/.mcp.json` from a pinned local checkout.

Installation changes the local Agent environment, so the Agent must first show
the target path, command, and rollback action and receive explicit approval.
Never run from a moving branch or a `latest` dependency.

## Local verification

```bash
python3 -m unittest discover -s tests -v
python3 /path/to/skill-creator/scripts/quick_validate.py \
  plugins/bizhub-core/skills/bizhub-bootstrap
python3 /path/to/plugin-creator/scripts/validate_plugin.py \
  plugins/bizhub-core
```

## Product boundary

This repository is a clean public distribution surface. It does not contain the
private BizHub application repository, customer data, production credentials,
internal operations plugins, or deployment access.

The MIT license in this repository applies only to this public bootstrap code.
Other BizHub software and customer-specific integrations may use different
terms.

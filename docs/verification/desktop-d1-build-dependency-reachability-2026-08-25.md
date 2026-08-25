# Desktop-D1 build dependency reachability — 2026-08-25

## Decision

Desktop-D1 may continue as an internal, unsigned technical proof on clean,
ephemeral build hosts. It is not approved for external release while the pinned
Forge development tree reports high or critical advisories.

`npm audit --omit=dev --audit-level=high` reports zero runtime
vulnerabilities. A complete `npm audit` reports 24 affected development nodes:
3 low, 20 high, and 1 critical. The derived Forge findings trace to the three
vulnerable packages below; none is present in the final `app.asar`.

## Advisory paths and reachability

| Package | Advisory | Dependency path | Reachability in D1 | Current disposition |
| --- | --- | --- | --- | --- |
| `extract-zip@2.0.1` | [GHSA-jmr9-qjv8-65gv](https://github.com/advisories/GHSA-jmr9-qjv8-65gv), high | Forge CLI → Forge core → Electron Packager → `extract-zip` | Build-time reachable when Electron Packager extracts an Electron archive. D1 supplies no user archive, but a compromised download or cache remains in scope. | Latest published `extract-zip` is still `2.0.1`; no patched version is available. Clean isolated builds and locked inputs reduce exposure but do not clear release. |
| `tar@6.2.1` | Critical aggregate; advisory list below | Forge CLI → Forge core/core-utils → Electron Rebuild → Electron node-gyp → `tar`; also node-gyp → `make-fetch-happen` → `cacache` → `tar` | Build-time reachable during dependency preparation or tool/header archive handling. D1 has no native runtime dependency, but Forge still executes its native-dependency preparation phase, so this is not classified unreachable. | Patched `tar@7.5.22` exists, but forcing an unsupported transitive major override has not been accepted. Formal release is blocked pending an upstream-compatible Forge/Rebuild path or separately proven replacement. |
| `tmp@0.0.33` | [GHSA-52f5-9888-hmc6](https://github.com/advisories/GHSA-52f5-9888-hmc6) and [GHSA-ph9p-34f9-6g65](https://github.com/advisories/GHSA-ph9p-34f9-6g65), high aggregate | Forge CLI → Inquirer prompts → Inquirer editor → `external-editor` → `tmp` | Installed in the development tree, but the interactive external-editor path is not invoked by `npm ci`, `vite build`, `electron-forge package`, or `electron-forge make` in the D1 workflow. | Not runtime-reachable in the reviewed commands. A patched `tmp@0.2.7` exists, but no forced transitive override is treated as release evidence without upstream compatibility. |

The `tar` aggregate contains:

- [GHSA-34x7-hfp2-rc4v](https://github.com/advisories/GHSA-34x7-hfp2-rc4v)
- [GHSA-8qq5-rm4j-mr97](https://github.com/advisories/GHSA-8qq5-rm4j-mr97)
- [GHSA-83g3-92jg-28cx](https://github.com/advisories/GHSA-83g3-92jg-28cx)
- [GHSA-qffp-2rhf-9h96](https://github.com/advisories/GHSA-qffp-2rhf-9h96)
- [GHSA-9ppj-qmqm-q256](https://github.com/advisories/GHSA-9ppj-qmqm-q256)
- [GHSA-r6q2-hw4h-h46w](https://github.com/advisories/GHSA-r6q2-hw4h-h46w)
- [GHSA-vmf3-w455-68vh](https://github.com/advisories/GHSA-vmf3-w455-68vh)
- [GHSA-w8wr-v893-vjvp](https://github.com/advisories/GHSA-w8wr-v893-vjvp)
- [GHSA-23hp-3jrh-7fpw](https://github.com/advisories/GHSA-23hp-3jrh-7fpw)
- [GHSA-8x88-c5mf-7j5w](https://github.com/advisories/GHSA-8x88-c5mf-7j5w)
- [GHSA-gvwx-54wh-qm9j](https://github.com/advisories/GHSA-gvwx-54wh-qm9j)
- [GHSA-r292-9mhp-454m](https://github.com/advisories/GHSA-r292-9mhp-454m)

## Build controls and release gate

- Dependencies are installed from the fixed lockfile on a clean runner.
- The Windows workflow does not restore a package-manager cache.
- Only repository source and the pinned Electron/toolchain downloads are build
  inputs; no customer file or connection envelope enters packaging.
- Artifact scanning proves `node_modules`, Forge, Rebuild, `extract-zip`, `tar`,
  and `tmp` do not enter `app.asar`.
- Development findings are not relabeled as runtime-safe release approval.

The only accepted outcomes before external distribution are an upstream-fixed
toolchain, a separately reviewed compatible replacement, or an explicit
security exception tied to a fixed artifact and isolated build procedure.
`npm audit fix --force` is not accepted because its suggested Forge downgrade is
not evidence that the current Electron 44 build remains correct or safer.

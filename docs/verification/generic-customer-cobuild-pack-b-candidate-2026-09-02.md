# Generic customer co-build Pack B candidate

Status: `implemented_not_merged_not_released_not_deployed`

The public Desktop now consumes the Pack B Owner from the deterministic
`bizhub-common` artifact and exposes four plain-language customer views:
conversation, known enterprise context, pending confirmations, and improvement
opportunities. It resumes the same Workspace revision after restart and never
uses a parallel Desktop knowledge store.

Fixed common source identity:

- private source commit: `834781b079c5d23d33bbaa45a7e4b27864d9d644`
- public source commit: `335b5d5`
- common artifact SHA-256:
  `d662fccc3a06b38feb43eb9e8b55f05e383dfdd5cd29d95c966cf7fe8e76a7a9`
- allowlisted files: `43`
- customer-private content violations: `0`

Implemented interactions:

- exactly one current question with ordinary examples;
- explicit send, unknown, defer, and skip choices;
- bounded pasted material/source description with credential-shaped input
  rejected before persistence;
- an inspectable candidate after the first effective answer or observation;
- visible source/classification boundary and suggestion-only experience cards;
- authenticated, post-entry, read-only successor Handoff.

Current local evidence:

- public Python artifact/CLI contracts: `24 passed`;
- Desktop source/security/release tests: `104 passed`;
- Vue type-check and production build: passed;
- macOS Runtime archive SHA-256:
  `f61d0ad13f03e7d9024ac445a0b227389ddc604670ea7f62622080615ea2591b`;
- Windows Runtime capture commit: `0856291`;
- Windows Runtime archive SHA-256:
  `4ce1791170957d6dcf2abf60ab3f1753ce2fafd8896e1ce09668916d482da7b8`;
- Windows Runtime pack tree:
  `bc812ee18f88f09671cc8fcffd7981a76d73d11972d70047448db18a426536a6`;
- Windows Runtime deterministic capture:
  [Desktop D3 Windows x64 run](https://github.com/kingcharleslzy-ai/bizhub-installer/actions/runs/33573719144), passed;
- coordinated Runtime/Manifest tamper: rejected by independent trust;
- real Electron local Workspace: `5` UI states × `7` viewports = `35`
  combinations, no document-level horizontal overflow;
- restart readback: the first candidate and the next unanswered question resume
  from the same Workspace revision; residual Runtime processes: `0`.

Both tracked Runtime archives now bind Pack B. The follow-up exact head must
still pass the complete remote D3 and dual-platform Workspace Flow matrices
before this candidate can be called merge-ready.

This candidate is not a fixed release. It does not authorize customer-data
migration, a production writer switch, deployment, arbitrary file/OCR/table
parsing, model inference, Blueprint compilation, module generation, or Profile
activation.

# Generic customer co-build Pack B candidate

Status: `implemented_not_merged_not_released_not_deployed`

The public Desktop now consumes the Pack B Owner from the deterministic
`bizhub-common` artifact and exposes four plain-language customer views:
conversation, known enterprise context, pending confirmations, and improvement
opportunities. It resumes the same Workspace revision after restart and never
uses a parallel Desktop knowledge store.

Fixed common source identity:

- private source commit: `834781b079c5d23d33bbaa45a7e4b27864d9d644`
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

The common-artifact Runtime tests currently pass (`4 passed`) and the Vue
type-check/production build passes. Final Electron viewport evidence and remote
macOS/Windows results are added only after the public review head is fixed.

This candidate is not a fixed release. It does not authorize customer-data
migration, a production writer switch, deployment, arbitrary file/OCR/table
parsing, model inference, Blueprint compilation, module generation, or Profile
activation.

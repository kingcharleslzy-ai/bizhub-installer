# Derived-image lifecycle Ubuntu E2E — 2026-08-15

## Scope

This record covers the first real lifecycle execution of the private candidate
bundle and public immutable-image plan boundary. It used only a synthetic
company, administrator, unit catalog and SQLite database on the previously
selected Ubuntu 24.04 VPS. It did not connect to or modify the private
production deployment, Tencent Cloud, or any customer data.

The host was an existing VPS rather than a newly provisioned clean host. The
application bound only to `127.0.0.1:18081`. At the end, uninstall first proved
that data and backups were retained by default; the test then removed the exact
temporary directory, containers and test images. Docker remained active with
zero containers, images and volumes, and systemd reported no failed unit.

## Immutable inputs

- public installer/core commit: `cf69f2674ecf5291cf061f25e6e42141c0978afa`;
- private source commit: `dfeb659cfd44a8c5c5c4f3164514a1a6e1fd337b`;
- private source tree: `cadfa614b4093940d8b04a4153e645f45dc9825f`;
- deterministic bundle SHA-256: `ae753795a71de6c497b4f0c5375ce49ee2009b66f6ed5e9a6f39a3b9ab594bef`;
- public core image id: `sha256:db48ba7f22ee8c98c43d5440890becdfe6faf534b6ff6e41720ff486efffecde`;
- private derived image id: `sha256:724f4f39a60d2d586352d1b7ded45a0079b4f8c9ecd385f9b66369a1e19b6479`;
- host: Ubuntu 24.04.4 LTS, x86_64, Docker Engine 29.1.3.

The private packager read exactly two committed regular files: the derived
Dockerfile and `dazheng_reference` package. The target-side builder used only
that bundle plus a detached public GitHub checkout, called the public image
validator, and emitted a `0600` receipt. The receipt status was
`development_candidate` because the public commit has no matching stable tag.

## Passed checks

1. The plan resolved both local image references to immutable ids and exactly
   matched the builder receipt.
2. Image validation matched the full public/private commits, proved that the
   private filesystem extended every public layer, preserved the core command,
   healthcheck, user and port metadata, and accepted only the fixed
   `dazheng_reference` import name.
3. Install created a TTY-only synthetic administrator and healthy loopback
   container from the approved derived image id. Repeating the same approved
   install returned `no_op` without rebuilding.
4. Authenticated system-map readback contained five public modules plus one
   private module. The extension reported matching core identity and
   `formal_business_write_capability=none`.
5. The test created one synthetic unit through preview/apply, made and hashed an
   online backup, added a second unit, restored the backup, and read back one
   unit. The restored database passed `bizhub.manage verify`.
6. A separately hashed second plan exercised update and automatic pre-update
   backup against the same immutable candidate. Repeating it returned `no_op`.
7. Final verify returned `status=ok`. Default uninstall returned
   `uninstalled_data_retained`; database and three `0600` backups still existed
   until the explicitly scoped test cleanup.

## Deliberately open gates

- `bizhubctl` still requires a real tag matching its version. The product code
  did not gain a development bypass. Because this commit is unreleased, the
  test harness supplied the already verified commit/tree identity directly to
  the same plan/install/update functions; the normal CLI release gate remained
  closed.
- The host was not an empty newly provisioned machine, and plugin installation
  from a fixed Release URL was not repeated.
- The extension is still synthetic-only and read-only. No production dual-read,
  formal writer, migration, TLS/domain, or customer-data access was attempted.

This closes the development candidate's build-to-lifecycle seam. It does not
promote a release or mean that the private production system already runs on
the public core.

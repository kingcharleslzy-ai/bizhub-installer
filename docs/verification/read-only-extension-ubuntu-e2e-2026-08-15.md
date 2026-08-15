# Read-only extension Ubuntu E2E — 2026-08-15

## Scope

This record covers the first real derived-image execution of the public
read-only extension boundary. It used synthetic company data only and did not
connect to, copy, or modify any production BizHub database or deployment.

The host was an existing shared Ubuntu 24.04 VPS, not a newly provisioned clean
host. Docker was installed from the Ubuntu repository for this test. Existing
host listeners were checked before and after; the candidate bound only to
`127.0.0.1:18081` and its container, images, backup, database, source checkout,
and temporary password file were removed at the end.

## Immutable inputs

- public core commit: `a92e0f0f130589dac659f8fca8c22a35474349a0`;
- customer-private extension commit: `acf6488f8b3f406d7bb7bcc165c64308a1fc6615`;
- public image id: `sha256:5ecf2797b7f09282c22bdaf7633dde7dac8e3ba2deb80f13510e0f5e9c567c3a`;
- derived image id: `sha256:5bd254cc999cbef210e753a48165955e8c9c86f0377feac88ed6d67f57671e60`;
- host: Ubuntu 24.04.4 LTS, x86_64, Docker Engine 29.1.3.

The public repository was cloned from GitHub and detached at the full public
commit. The private build context was produced from an exact Git archive and
contained only its extension package, derived Dockerfile, and build note. The
derived build log showed `FROM` the locally built public image; it did not copy
the public core source.

## Passed checks

1. Built the Vue/FastAPI public base image from the fixed public commit.
2. Built the customer-private image from that exact base with both commit
   labels and a `synthetic_only` data-mode declaration.
3. Initialized one synthetic administrator through password stdin; the
   candidate became Docker-healthy under a read-only root filesystem, dropped
   capabilities, and `no-new-privileges`.
4. Unauthenticated extension access returned `401`; authenticated access
   succeeded; POST to the extension path returned `405`.
5. The effective system map contained five built-in modules plus one
   customer-private read-only module, and its public commit matched the image
   label and extension expectation.
6. The private status readback matched the private image revision and reported
   no formal writer capability.
7. Ran the full synthetic purchase/sales/inventory flow: purchase 10, receive
   6, sell 4, ship 3, reject invalid units/negative cases/tampered or stale
   preview, replay an import without duplication, and reverse the shipment.
   Final inventory was 6.
8. Created and hashed an online SQLite backup at inventory 6, applied a
   post-backup adjustment to 8, restored the backup, and read back 6.
9. Restarted the derived container and read back health, extension identity,
   and inventory 6.
10. The existing single MCP connected to the configured loopback instance and
    returned healthy status plus the effective six-module system map.
11. Final `bizhub.manage verify` returned `status=ok`; all synthetic artifacts
    were then deleted. Existing host listeners remained present and systemd
    reported no failed unit.

## Gates still open

- The host was not empty, so this does not replace a clean Ubuntu 24.04 install
  test.
- The development commit is not a stable release tag. The private derived-image
  build is not yet compiled into `bizhubctl plan/install/update`.
- Plugin installation from a fixed release URL was not repeated in this server
  runtime test.
- No production dual-read, data migration, formal writer switch, TLS/domain, or
  customer-data access was attempted or authorized.

Therefore this evidence closes the first runtime extension seam only. It does
not change the current stable release or claim that a private production system
has adopted the public core.

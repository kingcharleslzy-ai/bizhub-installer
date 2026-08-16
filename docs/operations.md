# Operations

Run all commands on the approved Ubuntu 24.04 target from the exact tagged
checkout. `bizhubctl status` is read-only; mutations require root and, where
applicable, an exact approval string.

## Verify and back up

```bash
sudo ./bizhubctl verify
sudo ./bizhubctl status
sudo ./bizhubctl backup --label daily
```

Backups are SQLite online backups, written atomically to
`/var/backups/bizhub` and checked before publication. Copy them off-host using
the customer's approved encrypted backup system; this repository does not
invent a storage provider or credential path.

`status` and `verify` also compare the container's observed memory, memory-swap,
CPU, and PID limits with the approved plan. A missing limit or any drift is a failed
verification; do not hide it by restarting the container with an ad hoc Docker
command.

## Restore rehearsal

Choose one regular `.sqlite` file directly under `/var/backups/bizhub`:

```bash
sudo ./bizhubctl restore \
  --backup /var/backups/bizhub/bizhub-YYYYMMDDTHHMMSSZ-daily.sqlite
```

Restore first creates a new safety backup, stops the application, replaces the
database, starts the same image, and waits for health readback. Record the
tested recovery point and elapsed recovery time outside the repository.

## Update and rollback

Generate a new plan from the new fixed release. `update` verifies the target,
source, checksum, and exact approved hash, then backs up before building and
switching the container:

```bash
sudo ./bizhubctl update --plan next-plan.json --approve EXACT_PLAN_HASH
```

If health fails, the CLI restores the previous database backup and previous
image. Never delete the prior image or backup before verification.

## Prebuilt customer-private image

The first extension stage separates build authority from deployment authority.
A customer-owned tool may create a reviewed derived image, but `bizhubctl` does
not accept its source directory, Dockerfile path, registry tag, or arbitrary
build command. `plan` accepts only a local public-core image plus its local
derived image:

```bash
sudo ./bizhubctl plan \
  ... \
  --candidate-core-image sha256:<CORE_IMAGE_ID> \
  --candidate-image sha256:<DERIVED_IMAGE_ID> \
  --output private-plan.json
```

The plan binds both immutable image IDs, the public and private full commits,
extension mode and fixed import names. It also proves that the derived root
filesystem starts with every public-core layer and adds at least one private
layer, while preserving the core entrypoint, command, healthcheck, user and
exposed ports. Install and update repeat the same inspection immediately before
apply. Supplying only one image, pruning either image between plan and apply,
or retagging a different image fails closed.

## Uninstall

`uninstall` prints a confirmation derived from the installed plan. It stops
and removes only the application container. `/etc/bizhub`, `/var/lib/bizhub`,
and `/var/backups/bizhub` remain. Permanent deletion is deliberately outside
this CLI and requires a separate, customer-owned retention decision.

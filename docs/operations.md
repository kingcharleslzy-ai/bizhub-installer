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

`status` and `verify` compare both Docker metadata and the running container's
effective Linux cgroup v2 memory, additional swap, CPU, and PID limits with the
approved plan. Docker `--memory-swap` is a combined memory-plus-swap ceiling;
the plan's `swap_mib` and cgroup `memory.swap.max` are the additional swap
allowance. An unlimited, missing, unreadable, malformed, or mismatched cgroup
value is a failed verification even when `docker inspect` looks correct. Do not
hide drift by restarting the container with an ad hoc Docker command.

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

A successful update keeps one verified rollback point. To deliberately restore
the exact previous image, plan, resource limits, and pre-update database, read
the current plan hash from `bizhubctl status` and run:

```bash
sudo ./bizhubctl rollback --approve rollback:CURRENT_PLAN_HASH
```

Rollback first validates the stored backup manifest and creates a safety backup
of the current state. If the previous release fails health or resource readback,
the CLI recovers the state that existed immediately before rollback. A rollback
point is single-use and is not inferred from a tag or filename.

## Prebuilt customer-private image

A reviewed customer-owned build may create a derived image from the exact
public image, but `bizhubctl` does not accept an arbitrary source directory,
Dockerfile, registry tag, or build command. `plan` accepts only a local public
image plus its local derived image:

```bash
sudo ./bizhubctl plan \
  ... \
  --candidate-core-image sha256:<CORE_IMAGE_ID> \
  --candidate-image sha256:<DERIVED_IMAGE_ID> \
  --output private-plan.json
```

The plan binds both immutable image IDs, the public and private full commits,
the exact `bizhub-common` digest, extension mode, runtime Profile, and fixed
import names. It proves that the derived root filesystem starts with every
public layer and adds at least one private layer, while preserving the public
entrypoint, command, healthcheck, user, and exposed ports. Install and update
repeat the inspection immediately before apply. Supplying only one image,
changing the common digest, pruning either image, or retagging a different image
fails closed.

## Uninstall

`uninstall` prints a confirmation derived from the installed plan. It stops
and removes only the application container. `/etc/bizhub`, `/var/lib/bizhub`,
and `/var/backups/bizhub` remain. Permanent deletion is deliberately outside
this CLI and requires a separate, customer-owned retention decision.

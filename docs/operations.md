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

## Uninstall

`uninstall` prints a confirmation derived from the installed plan. It stops
and removes only the application container. `/etc/bizhub`, `/var/lib/bizhub`,
and `/var/backups/bizhub` remain. Permanent deletion is deliberately outside
this CLI and requires a separate, customer-owned retention decision.

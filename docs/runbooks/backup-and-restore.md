# Backup And Restore

## Backup Scope

- PostgreSQL data;
- object storage data;
- environment and deployment configuration.

## Minimum Procedure

1. Take a consistent PostgreSQL backup.
2. Snapshot or replicate object storage.
3. Store deployment configuration separately from the host.
4. Test restore into a non-production environment.

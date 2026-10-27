-- Run only against a disposable QA database after creating a user and text channel.
-- psql -v channel_id=<UUID> -v author_id=<UUID> -v count=3000 -f tools/perf/seed-qa.sql
-- This refuses the production database name used by the single-node installation.
DO $$ BEGIN
  IF current_database() = 'cirvo' THEN RAISE EXCEPTION 'Refusing production database'; END IF;
END $$;
INSERT INTO messages (id, channel_id, author_user_id, body, created_at)
SELECT gen_random_uuid(), :'channel_id'::uuid, :'author_id'::uuid,
       'Performance fixture ' || n,
       now() - interval '1 day' + n * interval '1 second'
FROM generate_series(1, :count) AS n;

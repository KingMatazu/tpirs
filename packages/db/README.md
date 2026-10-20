# @tpirs/db

Kysely connection factory, SQL migrations, and CLI scripts (`migrate up|down|status|check`, `seed`). All schema access goes through repository interfaces defined by consumers — this package owns only the connection, the migration runner, and the schema itself. `migrate check` applies every migration to the configured database and then rolls back to zero, proving migrations are reversible; CI runs it against a scratch Postgres.

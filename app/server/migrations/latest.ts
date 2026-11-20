// The newest migration's name (its file name without `.sql`). The health route's `migrations` signal compares the last
// applied migration with it; server/db/migrations.test.ts fails when a migration is added without updating it.
export const LATEST_MIGRATION = '0005_service_rows'

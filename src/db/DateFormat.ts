/**
 * `YYYY-MM-DD HH:MM:SS` in UTC - the shape sqlite and mysql both store dates in.
 *
 * Kept out of `query.ts` so the sqlite driver can use it without importing the
 * Kysely instance (which would be a cycle, and would also pick up the postgres
 * variant of `toDbDate()` once that exists).
 */
export function toSqlDateTime(date: Date): string {
    return date.toISOString().slice(0, 19).replace('T', ' ');
}

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

/**
 * The other direction. postgres hands back a `Date` already; sqlite and mysql
 * hand back the string above, and `new Date('2026-09-04 17:25:44')` reads that
 * as *local* time even though it was written in UTC - so every comparison
 * against a stored date was off by the machine's offset.
 */
export function fromDbDate(value: Date | string): Date {
    if (value instanceof Date) {
        return value;
    }

    if (/[zZ]$|[+-]\d\d:?\d\d$/.test(value)) {
        return new Date(value);
    }

    return new Date(value.replace(' ', 'T') + 'Z');
}

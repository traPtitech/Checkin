/**
 * Structural readers for values the mysql2 driver produces and drizzle-orm passes
 * through without declaring their shape.
 *
 * Both readers narrow with `typeof` and the `in` operator instead of a type
 * assertion, so a driver that stops producing the expected shape falls back to
 * the documented default here rather than being silently mistyped.
 */

/**
 * Number of rows an UPDATE touched.
 *
 * drizzle's mysql2 driver resolves an `update(...)` to the driver's
 * `ResultSetHeader` (which carries `affectedRows`); depending on the driver
 * version it can instead resolve to the `[ResultSetHeader, FieldPacket[]]` tuple.
 * Neither shape appears in drizzle's declared return type, so both are read here.
 * Returns 0 when neither shape is present, which callers read as "claimed
 * nothing" — the same conservative outcome as an UPDATE that matched no row.
 */
export function affectedRowCount(result: unknown): number {
  const head: unknown = Array.isArray(result) ? result[0] : result
  if (typeof head === 'object' && head !== null && 'affectedRows' in head) {
    const affected = head.affectedRows
    return typeof affected === 'number' ? affected : 0
  }
  return 0
}

/**
 * Whether an error is a MySQL/MariaDB duplicate-key error (ER_DUP_ENTRY = 1062).
 *
 * Walks the `cause` chain because drizzle wraps the mysql2 error and carries the
 * original (with `code`/`errno`) as `.cause`. Measured on 2026-09-18 with
 * drizzle-orm 0.45.2 + mysql2 3.23.2 against MariaDB 11, by inserting a row that
 * violates `membership_slots_user_year_half_uq` twice: the thrown value is a
 * `DrizzleQueryError` ("Failed query: insert into `membership_slots` ...") that
 * carries NEITHER `code` NOR `errno`, and its `.cause` (one link down, with no
 * further `cause`) is the mysql2 `Error` with `code: 'ER_DUP_ENTRY'` and
 * `errno: 1062`. So reading only the top level never detects a duplicate here.
 * The walk is bounded at 5 links — more than the one link measured, so an added
 * wrapper still resolves — and the bound stops a self-referential chain from
 * looping forever.
 */
export function isDuplicateKeyError(err: unknown): boolean {
  let cur: unknown = err
  for (let depth = 0; depth < 5; depth++) {
    if (cur === null || (typeof cur !== 'object' && typeof cur !== 'function')) {
      return false
    }
    if (('code' in cur && cur.code === 'ER_DUP_ENTRY') || ('errno' in cur && cur.errno === 1062)) {
      return true
    }
    cur = 'cause' in cur ? cur.cause : undefined
  }
  return false
}

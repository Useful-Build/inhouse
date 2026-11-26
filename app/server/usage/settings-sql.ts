// The brand's spending settings as SQL expressions, so a ledger batch reads them in the same transaction as its write
// (p3-design section 9: the cap is read from `settings` inside the reserve batch). Values are stored as JSON
// (`settings.value_json`): `s:cap` is the money field's saved text (`"$320"`, `"$300.50"`, settings-table.ts
// `CAP_PATTERN` and `capOk`), `s:job_cap` uses the same format, and `s:alert` is one of `ALERT_AT`. A reset stores `null`.
import { DEFAULT_JOB_BUDGET_USD, MAX_JOB_BUDGET_USD, MIN_JOB_BUDGET_USD } from '../../shared/contract/settings-table.ts'

const moneyMicroSql = (key: 's:cap' | 's:job_cap') => `(SELECT CASE
    WHEN w <> '' AND w NOT GLOB '*[^0-9]*' AND length(w) <= 6
      AND (c IS NULL OR (length(c) = 2 AND c NOT GLOB '*[^0-9]*'))
    THEN CAST(w AS INTEGER) * 1000000 + COALESCE(CAST(c AS INTEGER), 0) * 10000 END
  FROM (SELECT CASE WHEN instr(d, '.') > 0 THEN substr(d, 1, instr(d, '.') - 1) ELSE d END AS w,
               CASE WHEN instr(d, '.') > 0 THEN substr(d, instr(d, '.') + 1) ELSE NULL END AS c
        FROM (SELECT substr(v, 2) AS d
              FROM (SELECT json_extract(value_json, '$') AS v FROM settings
                    WHERE owner = 'brand' AND key = '${key}' AND json_valid(value_json))
              WHERE typeof(v) = 'text' AND substr(v, 1, 1) = '$')))`

/**
 * `s:cap` in micro-USD; 0 when the row is missing, reset or not a valid cap (above $0, at most $100,000, whole dollars
 * or two-digit cents, no grouping), so nothing can be reserved against it. settings-sql.test.ts compares it with
 * `capOk` on generated text.
 */
export const CAP_MICRO_SQL = `(SELECT CASE WHEN micro BETWEEN 1 AND 100000000000 THEN micro ELSE 0 END
  FROM (SELECT ${moneyMicroSql('s:cap')} AS micro))`

/**
 * `s:job_cap` in micro-USD, snapshotted by `openJob`: the default ($25) when the row is missing, reset, not valid money
 * text or below the start hold; a value above the code ceiling ($100) is clamped to it, even one stored directly.
 * settings-sql.test.ts compares it with `capOk(v, MAX_JOB_BUDGET_USD, MIN_JOB_BUDGET_USD)` on generated text.
 */
export const JOB_BUDGET_MICRO_SQL = `(SELECT CASE WHEN micro >= ${Math.round(MIN_JOB_BUDGET_USD * 1_000_000)}
    THEN MIN(micro, ${MAX_JOB_BUDGET_USD * 1_000_000}) ELSE ${DEFAULT_JOB_BUDGET_USD * 1_000_000} END
  FROM (SELECT ${moneyMicroSql('s:job_cap')} AS micro))`

/** What `s:alert` means when it isn't set: the Usage page's default level. */
export const DEFAULT_ALERT_PCT = 80

/** `s:alert` as a percent of the cap; the default when unset or not one of the Settings page's levels. */
export const ALERT_PCT_SQL = `COALESCE((SELECT CASE json_extract(value_json, '$')
    WHEN '50%' THEN 50 WHEN '70%' THEN 70 WHEN '80%' THEN 80 WHEN '90%' THEN 90 WHEN '100%' THEN 100 END
  FROM settings WHERE owner = 'brand' AND key = 's:alert' AND json_valid(value_json)), ${DEFAULT_ALERT_PCT})`

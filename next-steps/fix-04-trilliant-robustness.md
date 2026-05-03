# Fix 04: Trilliant Hospital Pricing Robustness

> **AGENT INSTRUCTIONS:** You are implementing fix 04.
> Work in `/root/projects/hospital-bill-checker`. Read `next-steps/README.md` for project context.

**Goal:** Fix four bugs in `scripts/fetch_hospital_trilliant.py` that cause wrong hospital data to be cached, partial/corrupt SQLite files to be served, and silent null values for negotiated rate columns.

---

## Background

Four bugs were found in the Trilliant hospital pricing fetch script:

- **P5 (CRITICAL):** `phone` argument is accepted but completely ignored. The cache key is built from `hospital_name` + `state` only. Two different hospitals with the same name in the same state (e.g., two "Memorial Hospital" in Texas) get the same cache key — wrong hospital's prices are served for one of them.
- **P6 (CRITICAL):** On `convert_duckdb_to_sqlite` exception, the partial SQLite file is not cleaned up inside that function. The caller in `fetch_hospital_pricing` does clean it up, but there is a race condition: the server can read the cache between the exception being thrown and the caller deleting the file, serving corrupt data.
- **P9 (IMPORTANT):** The `min_negotiated`/`max_negotiated` column name mapping uses exact string equality against a small fixed set: `"minimum"`, `"min_negotiated_rate"`, `"min_negotiated"`. Common MRF column names like `"minimum_rate"`, `"min_rate"`, `"min_neg_rate"` silently map to NULL, so negotiated rate comparisons never fire for many hospitals.
- **P6 (cleanup):** The `convert_duckdb_to_sqlite` function itself does not clean up the partial SQLite on exception — it relies on the caller. The function should clean up internally so there is no window for corrupt data.

---

## Task 1: Fix P5 — Include phone in the cache key

**File:** `scripts/fetch_hospital_trilliant.py`

Find `fetch_hospital_pricing` (around line 451):

```python
def fetch_hospital_pricing(
    hospital_name: str,
    state: str | None = None,
    phone: str | None = None,
) -> Path | None:
    """
    Main entry point. Returns path to SQLite cache file, or None if failed.
    """
    CACHE_DIR.mkdir(parents=True, exist_ok=True)

    # Build a stable hospital_id for the cache
    hospital_id = normalize_name(hospital_name).replace(" ", "_")[:60]
    if state:
        hospital_id += f"_{state.lower()}"
    cache_path = make_cache_path(hospital_id)
```

Replace the `hospital_id` construction with:

```python
    CACHE_DIR.mkdir(parents=True, exist_ok=True)

    # Build a stable hospital_id for the cache.
    # Include phone number (normalized) when provided — same name + state can match
    # different hospitals (e.g. two "Memorial Hospital" in Texas).
    hospital_id = normalize_name(hospital_name).replace(" ", "_")[:60]
    if state:
        hospital_id += f"_{state.lower()}"
    if phone:
        # Normalize phone to digits only for a stable cache key component
        phone_digits = "".join(c for c in phone if c.isdigit())
        if phone_digits:
            hospital_id += f"_ph{phone_digits[-10:]}"  # last 10 digits (local number)
    cache_path = make_cache_path(hospital_id)
```

---

## Task 2: Fix P6 — Clean up partial SQLite inside `convert_duckdb_to_sqlite`

**File:** `scripts/fetch_hospital_trilliant.py`

Find `convert_duckdb_to_sqlite`. It currently looks like this at the end:

```python
    except Exception as exc:
        print(f"  DuckDB conversion failed: {exc}")
        return False
```

Replace:

```python
    except Exception as exc:
        print(f"  DuckDB conversion failed: {exc}")
        # Clean up partial SQLite immediately — do not leave a corrupt file on disk.
        # The server may poll the cache directory between this exception and the caller
        # cleaning up, which would serve corrupt data.
        if sqlite_path.exists():
            try:
                sqlite_path.unlink()
                print(f"  Cleaned up partial SQLite: {sqlite_path}")
            except OSError as cleanup_err:
                print(f"  WARNING: Could not clean up partial SQLite {sqlite_path}: {cleanup_err}")
        return False
```

You also need to make sure `sqlite_path` is visible in the `except` block. Check that the function signature passes `sqlite_path` as a parameter (it should — the function takes `output_sqlite: Path`). If the variable inside the function is named `output_sqlite` (not `sqlite_path`), adjust accordingly. Check the actual variable name in the function and use it consistently.

---

## Task 3: Fix P9 — Expand `min_negotiated`/`max_negotiated` column name matching

**File:** `scripts/fetch_hospital_trilliant.py`

Find the column mapping block (around line 369):

```python
            col_map = {
                ...
                "min_negotiated": next((sql_ident(c) for c in cols if c.lower() in ("minimum", "min_negotiated_rate", "min_negotiated")), None),
                "max_negotiated": next((sql_ident(c) for c in cols if c.lower() in ("maximum", "max_negotiated_rate", "max_negotiated")), None),
                ...
            }
```

Replace the `min_negotiated` and `max_negotiated` lines with broader substring matching:

```python
            def find_min_col(cols: list[str]) -> str | None:
                """Find the minimum negotiated rate column by common MRF naming patterns."""
                # Exact matches first (highest confidence)
                exact = {"minimum", "min_negotiated_rate", "min_negotiated", "min_rate",
                         "minimum_negotiated_rate", "minimum_rate", "min_neg_rate",
                         "negotiated_rate_min", "minimum_negotiated"}
                for c in cols:
                    if c.lower() in exact:
                        return sql_ident(c)
                # Substring fallback: must contain "min" and ("negot" or "rate")
                for c in cols:
                    cl = c.lower()
                    if "min" in cl and ("negot" in cl or "rate" in cl) and "max" not in cl:
                        return sql_ident(c)
                return None

            def find_max_col(cols: list[str]) -> str | None:
                """Find the maximum negotiated rate column by common MRF naming patterns."""
                exact = {"maximum", "max_negotiated_rate", "max_negotiated", "max_rate",
                         "maximum_negotiated_rate", "maximum_rate", "max_neg_rate",
                         "negotiated_rate_max", "maximum_negotiated"}
                for c in cols:
                    if c.lower() in exact:
                        return sql_ident(c)
                for c in cols:
                    cl = c.lower()
                    if "max" in cl and ("negot" in cl or "rate" in cl) and "min" not in cl:
                        return sql_ident(c)
                return None

            col_map = {
                ...
                "min_negotiated": find_min_col(cols),
                "max_negotiated": find_max_col(cols),
                ...
            }
```

Place the helper functions (`find_min_col`, `find_max_col`) just before the `convert_duckdb_to_sqlite` function definition (not inside the loop) so they are module-level utilities.

After the column mapping is built, log a warning if either rate column mapped to NULL:

```python
            if col_map.get("min_negotiated") is None:
                print(f"  WARNING: Could not find min_negotiated column. Available columns: {cols}")
            if col_map.get("max_negotiated") is None:
                print(f"  WARNING: Could not find max_negotiated column. Available columns: {cols}")
```

---

## Task 4: Verify caller still cleans up (defensive redundancy)

**File:** `scripts/fetch_hospital_trilliant.py`

The caller (`fetch_hospital_pricing`) already cleans up on failure:

```python
    if not success:
        cache_path.unlink(missing_ok=True)
        return None
```

This is good — leave it in place. After Task 2's fix, both the function and the caller clean up, which is safe (the second `unlink` is a no-op because `missing_ok=True`).

---

## Verification

- [ ] Two hospitals with the same name and state but different phone numbers produce different cache keys (different filenames in `data/hospital_cache/`)
- [ ] If `convert_duckdb_to_sqlite` raises an exception, the partial SQLite file is removed before the function returns `False`
- [ ] A hospital MRF with column `minimum_negotiated_rate` maps `min_negotiated` correctly (not NULL)
- [ ] A hospital MRF with column `min_rate` maps `min_negotiated` correctly
- [ ] Run: `python scripts/fetch_hospital_trilliant.py "Test Hospital" --state TX --phone 5125551234` — should create cache file with `_ph5125551234` suffix in the name
- [ ] `npm run check` passes (no TypeScript changes in this fix)
- [ ] `npm run test` passes

---

## Commit

```bash
git add scripts/fetch_hospital_trilliant.py
git commit -m "fix: trilliant — phone in cache key, cleanup partial SQLite on exception, expanded rate column matching"
```

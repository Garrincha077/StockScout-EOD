from __future__ import annotations

import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = next((ROOT / "supabase" / "migrations").glob("*_stockscout_eod_cloud_security.sql"))
FACADE_MIGRATION = next(
    (ROOT / "supabase" / "migrations").glob("*_eod_edge_owner_api.sql")
)
FUNCTION = ROOT / "supabase" / "functions" / "stockscout-eod-publish" / "index.ts"
DATABASE_FUNCTION = (
    ROOT / "supabase" / "functions" / "stockscout-eod-publish" / "database.ts"
)
ALERTS_FUNCTION = ROOT / "supabase" / "functions" / "stockscout-eod-publish" / "alerts.ts"
JCS_FIXTURE = (
    ROOT / "supabase" / "functions" / "stockscout-eod-publish" / "jcs_fixture.json"
)


def _fixture_jcs(value: object) -> str:
    """Python half of the shared JCS fixture.

    The fixture deliberately contains integer-valued floats, the historical
    Python/JavaScript mismatch this contract is intended to catch.  Production
    hashing is implemented once in the Edge JCS module and the publisher must
    emit the same canonical bytes.
    """

    def normalize(item: object) -> object:
        if isinstance(item, dict):
            return {str(key): normalize(nested) for key, nested in item.items()}
        if isinstance(item, list):
            return [normalize(nested) for nested in item]
        if isinstance(item, float) and item.is_integer():
            return int(item)
        return item

    return json.dumps(
        normalize(value), ensure_ascii=False, sort_keys=True, separators=(",", ":")
    )


class CloudSecurityContractTest(unittest.TestCase):
    def test_all_eod_public_tables_enable_rls(self) -> None:
        sql = MIGRATION.read_text(encoding="utf-8").lower()
        tables = (
            "eod_scans",
            "eod_scan_state",
            "eod_candidates",
            "eod_candidate_history",
            "eod_scan_fields",
            "eod_watchlists",
            "eod_saved_screens",
            "eod_drawings",
            "eod_alerts",
            "eod_alert_events",
            "eod_delivery_state",
        )
        for table in tables:
            self.assertIn(f"alter table public.{table} enable row level security", sql)

    def test_owner_policies_require_private_allowlist(self) -> None:
        sql = MIGRATION.read_text(encoding="utf-8").lower()
        self.assertIn("stockscout_private.eod_owners", sql)
        self.assertGreaterEqual(sql.count("stockscout_private.eod_is_owner()"), 18)
        self.assertNotIn("user_metadata", sql)
        self.assertIn("security definer\nset search_path = ''", sql)

    def test_public_reads_and_private_writes_are_explicit(self) -> None:
        sql = MIGRATION.read_text(encoding="utf-8").lower()
        self.assertIn("for select to anon, authenticated using (true)", sql)
        self.assertIn("from public, anon, authenticated, service_role", sql)
        self.assertIn("to service_role", sql)
        self.assertIn("with (security_invoker = true)", sql)

    def test_storage_access_models_are_distinct(self) -> None:
        sql = MIGRATION.read_text(encoding="utf-8").lower()
        self.assertIn("'stockscout-eod-charts'", sql)
        self.assertIn("create policy eod_chart_owner_read", sql)
        self.assertIn("'stockscout-eod-market-cache'", sql)
        self.assertNotIn("create policy eod_market_cache", sql)

    def test_edge_function_pins_oidc_claims_and_hashes_blobs(self) -> None:
        source = FUNCTION.read_text(encoding="utf-8")
        for claim in (
            "payload.repository",
            "payload.ref",
            "payload.workflow_ref",
            "payload.environment",
            "payload.ref_protected",
        ):
            self.assertIn(claim, source)
        self.assertIn('const AUDIENCE = "stockscout-eod-publish"', source)
        self.assertIn("blob content hash mismatch", source)
        self.assertIn('if (shard === "manifest") cacheControl = "0"', source)
        self.assertNotIn("SUPABASE_SERVICE_ROLE_KEY=", source)

    def test_oidc_delivery_resume_actions_are_owner_scoped_and_allowlisted(self) -> None:
        source = FUNCTION.read_text(encoding="utf-8")
        database = DATABASE_FUNCTION.read_text(encoding="utf-8")
        sql = MIGRATION.read_text(encoding="utf-8").lower()
        self.assertIn("lookupSingleOwner(database)", source)
        self.assertIn('rpc("eod_edge_single_owner_id")', database)
        self.assertNotIn("STOCKSCOUT_OWNER_ID", source)
        self.assertIn("public.eod_single_owner_id()", sql)
        self.assertIn("v_count <> 1", sql)
        self.assertIn('new Set(["daily", "operational_error"])', source)
        self.assertIn('action === "delivery_get"', source)
        self.assertIn('action === "delivery_progress"', source)
        self.assertIn("p_user_id: ownerId", source)
        self.assertIn("public.eod_get_delivery_state", sql)
        self.assertIn("public.eod_record_delivery_progress", sql)
        self.assertIn("delivery owner is not allowlisted", sql)
        self.assertIn("greatest(\n        eod_delivery_state.last_successful_part", sql)

    def test_edge_owner_lookup_uses_service_only_exposed_schema_bridge(self) -> None:
        database = DATABASE_FUNCTION.read_text(encoding="utf-8")
        facade = FACADE_MIGRATION.read_text(encoding="utf-8").lower()
        self.assertIn("schema(EDGE_API_SCHEMA)", database)
        self.assertIn('EDGE_API_SCHEMA = "stockscout_api"', database)
        self.assertIn(
            "security invoker\nset search_path = ''",
            facade,
        )
        self.assertIn(
            "revoke all on function\n"
            "  stockscout_api.eod_edge_single_owner_id(),",
            facade,
        )
        self.assertIn(
            "stockscout_api.eod_edge_single_owner_id(),",
            facade,
        )
        self.assertNotIn(
            "grant execute on function stockscout_api.eod_edge_single_owner_id()\n"
            "  to authenticated",
            facade,
        )

    def test_exposed_facade_is_narrow_invoker_scoped_and_complete(self) -> None:
        sql = FACADE_MIGRATION.read_text(encoding="utf-8").lower()
        for view in (
            "eod_scans",
            "eod_candidate_history",
            "eod_latest_scan",
            "eod_latest_candidates",
            "eod_latest_fields",
            "eod_scan_history",
            "eod_watchlists",
            "eod_saved_screens",
            "eod_drawings",
            "eod_alerts",
            "eod_alert_events",
            "eod_delivery_state",
        ):
            self.assertIn(f"view stockscout_api.{view}", sql)
        self.assertGreaterEqual(sql.count("with (security_invoker = true)"), 12)
        self.assertIn("grant usage on schema stockscout_api", sql)
        self.assertNotIn("grant usage on schema public", sql)
        self.assertIn("stockscout_api.eod_begin_publish(jsonb)", sql)
        self.assertIn("stockscout_api.eod_finalize_publish(uuid)", sql)
        self.assertIn("stockscout_api.eod_upsert_alert_events(jsonb)", sql)
        self.assertIn("on conflict (user_id, event_key) do nothing", sql)
        self.assertIn("alert event owner or alert is not allowlisted", sql)
        self.assertIn(
            "stockscout_api.eod_set_watchlist_ticker(text, text, boolean)", sql
        )
        self.assertIn("v_user_id uuid := (select auth.uid())", sql)
        self.assertIn("on conflict (user_id, name, ticker) do nothing", sql)

    def test_publish_wrapper_hash_matches_cross_language_jcs_fixture(self) -> None:
        fixture = json.loads(JCS_FIXTURE.read_text(encoding="utf-8"))
        canonical = _fixture_jcs(fixture["wrapper"])
        self.assertEqual(canonical, fixture["canonical"])
        self.assertEqual(
            hashlib.sha256(canonical.encode("utf-8")).hexdigest(), fixture["sha256"]
        )
        edge_source = (
            ROOT / "supabase" / "functions" / "stockscout-eod-publish" / "jcs.ts"
        ).read_text(encoding="utf-8")
        self.assertIn("publishRecordWrapper", edge_source)
        self.assertIn("scanOrder: row.scanOrder", edge_source)

    def test_finalize_sources_compact_summary_from_staging(self) -> None:
        sql = MIGRATION.read_text(encoding="utf-8").lower()
        self.assertIn(
            "join stockscout_private.eod_publish_records r\n"
            "    on r.upload_id = p_upload_id and r.ticker = c.ticker",
            sql,
        )
        self.assertIn("jsonb_strip_nulls(r.summary || jsonb_build_object", sql)
        self.assertIn("string_agg(record_hash", sql)

    def test_repeated_begin_resets_partial_staging_and_cleanup_is_service_only(self) -> None:
        sql = MIGRATION.read_text(encoding="utf-8").lower()
        self.assertIn(
            "delete from stockscout_private.eod_publish_records\n"
            "  where upload_id = v_upload_id",
            sql,
        )
        self.assertIn("public.eod_cleanup_abandoned_publish()", sql)

    def test_oidc_alert_evaluation_is_owner_scoped_allowlisted_and_idempotent(self) -> None:
        edge = FUNCTION.read_text(encoding="utf-8")
        evaluator = ALERTS_FUNCTION.read_text(encoding="utf-8")
        facade = FACADE_MIGRATION.read_text(encoding="utf-8").lower()
        self.assertIn('action === "evaluate_alerts"', edge)
        self.assertIn('.eq("user_id", ownerId)', edge)
        self.assertIn('.rpc("eod_upsert_alert_events"', edge)
        self.assertIn("on conflict (user_id, event_key) do nothing", facade)
        self.assertIn("alertEventKey(runId, evaluation.alertId, ticker)", edge)
        self.assertIn('"trade_status"', evaluator)
        self.assertIn('"screen"', evaluator)
        self.assertIn("invalid_or_non_allowlisted_screen_filter", evaluator)
        self.assertIn("chart_and_drawing_alerts_require_bar_data", evaluator)


class OwnerStateMigrationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        path = ROOT / "scripts" / "migrate_owner_state.py"
        spec = importlib.util.spec_from_file_location("migrate_owner_state", path)
        assert spec and spec.loader
        cls.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.module)

    def test_dry_run_normalizes_without_network_or_content_output(self) -> None:
        owner = "00000000-0000-4000-8000-000000000001"
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "watchlists.json"
            path.write_text('["AAPL", "MSFT"]', encoding="utf-8")
            rows = self.module.normalize_watchlists(
                self.module._load(path), owner
            )
        self.assertEqual([row["ticker"] for row in rows], ["AAPL", "MSFT"])
        self.assertTrue(all(row["user_id"] == owner for row in rows))

    def test_stable_ids_make_retries_idempotent(self) -> None:
        owner = "00000000-0000-4000-8000-000000000001"
        item = {"ticker": "AAPL", "payload": {"kind": "line"}}
        first = self.module.normalize_drawings([item], owner)[0]["id"]
        second = self.module.normalize_drawings([item], owner)[0]["id"]
        self.assertEqual(first, second)

    def test_current_named_watchlist_and_grouped_alert_shapes_are_supported(self) -> None:
        owner = "00000000-0000-4000-8000-000000000001"
        watchlists = self.module.normalize_watchlists(
            {
                "version": 2,
                "lists": [
                    {
                        "name": "Focus",
                        "tickers": ["AAPL"],
                        "items": [{"ticker": "AAPL", "note": "review"}, {"ticker": "MSFT"}],
                    }
                ],
            },
            owner,
        )
        alerts = self.module.normalize_alerts(
            {"screen": [{"id": "s1", "name": "Ready", "filter": {}}], "price": [], "drawing": [], "watchlist": []},
            owner,
        )
        self.assertEqual([row["ticker"] for row in watchlists], ["AAPL", "MSFT"])
        self.assertEqual(alerts[0]["name"], "Ready")


if __name__ == "__main__":
    unittest.main()

-- Backfill monthly question counters from messages asked before quotas existed, so the usage
-- page and the monthly limit start from the real count. Periods use the reporting time zone
-- (America/Toronto, see @traiblazer/shared REPORTING_TIME_ZONE).
INSERT INTO usage_counters (tenant_id, period, questions)
SELECT tenant_id, to_char(created_at AT TIME ZONE 'America/Toronto', 'YYYY-MM'), count(*)::int
FROM messages
WHERE role = 'user'
GROUP BY 1, 2
ON CONFLICT (tenant_id, period)
DO UPDATE SET questions = GREATEST(usage_counters.questions, EXCLUDED.questions);

-- Scores by the hour, for the dashboard's long chart. A view, because 14 days of scans is far
-- more rows than one API response returns. security_invoker, so it applies the caller's RLS.
create view public.score_history with (security_invoker = true) as
  select project_id,
         date_trunc('hour', created_at) as hour,
         round(avg(score))::smallint as score,
         bool_and(source = 'seed') as seeded
  from public.scan_runs
  group by project_id, date_trunc('hour', created_at);

revoke all on public.score_history from anon, authenticated;
grant select on public.score_history to anon, authenticated;

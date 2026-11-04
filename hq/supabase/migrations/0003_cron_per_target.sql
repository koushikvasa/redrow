-- One sweep per database: the two together ran past an edge function's compute limit.
-- To stop them: select cron.unschedule('redrow-sweep-carenote'); select cron.unschedule('redrow-sweep-hq');
select cron.unschedule('redrow-sweep');

select cron.schedule('redrow-sweep-carenote', '* * * * *', $$
  select net.http_post(
    url     := 'https://hwcqrzagivtototosstn.supabase.co/functions/v1/sweep?target=carenote',
    headers := jsonb_build_object('Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'sweep_token'),
                                  'Content-Type', 'application/json'),
    body    := '{}'::jsonb,
    timeout_milliseconds := 55000);
$$);

select cron.schedule('redrow-sweep-hq', '* * * * *', $$
  select net.http_post(
    url     := 'https://hwcqrzagivtototosstn.supabase.co/functions/v1/sweep?target=hq',
    headers := jsonb_build_object('Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'sweep_token'),
                                  'Content-Type', 'application/json'),
    body    := '{}'::jsonb,
    timeout_milliseconds := 55000);
$$);

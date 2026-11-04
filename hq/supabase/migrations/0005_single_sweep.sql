-- Back to one request a minute. With two sent in the same instant, about half of them stalled
-- in pg_net's DNS lookup until the timeout, and the sweeps ran minutes apart.
-- To stop it: select cron.unschedule('redrow-sweep');
select cron.unschedule('redrow-sweep-carenote');
select cron.unschedule('redrow-sweep-hq');

select cron.schedule('redrow-sweep', '* * * * *', $$
  select net.http_post(
    url     := 'https://hwcqrzagivtototosstn.supabase.co/functions/v1/sweep',
    headers := jsonb_build_object('Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'sweep_token'),
                                  'Content-Type', 'application/json'),
    body    := '{}'::jsonb,
    timeout_milliseconds := 55000);
$$);

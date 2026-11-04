-- About every other pg_net request stalls in its DNS lookup, even one at a time, so a sweep
-- a minute really ran every two or three. This asks every 20 seconds with a short timeout,
-- and the function skips a database swept in the last 50 seconds.
-- To stop it: select cron.unschedule('redrow-sweep');
select cron.unschedule('redrow-sweep');

select cron.schedule('redrow-sweep', '20 seconds', $$
  select net.http_post(
    url     := 'https://hwcqrzagivtototosstn.supabase.co/functions/v1/sweep',
    headers := jsonb_build_object('Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'sweep_token'),
                                  'Content-Type', 'application/json'),
    body    := '{}'::jsonb,
    timeout_milliseconds := 15000);
$$);

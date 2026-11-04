-- Sweeps both demo databases every minute, which is also what keeps these tables fresh.
-- The project ref isn't a secret: it's in every client URL. The token lives in Vault.
-- To stop it: select cron.unschedule('redrow-sweep');
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule('redrow-sweep', '* * * * *', $$
  select net.http_post(
    url     := 'https://hwcqrzagivtototosstn.supabase.co/functions/v1/sweep',
    headers := jsonb_build_object('Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'sweep_token'),
                                  'Content-Type', 'application/json'),
    body    := '{}'::jsonb,
    timeout_milliseconds := 55000);  -- a sweep takes several seconds, well past the 5s default
$$);

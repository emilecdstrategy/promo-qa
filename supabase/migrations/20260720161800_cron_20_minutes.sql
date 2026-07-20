do $$
declare
  v_job_id bigint;
begin
  for v_job_id in
    select jobid
    from cron.job
    where jobname in ('promo-qa-every-10-minutes', 'promo-qa-every-20-minutes')
  loop
    perform cron.unschedule(v_job_id);
  end loop;
end;
$$;

select cron.schedule(
  'promo-qa-every-20-minutes',
  '*/20 * * * *',
  'select public.invoke_promo_qa_runner();'
);

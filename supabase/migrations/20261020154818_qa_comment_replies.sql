-- One reply per Asana comment (Emil, 2026-10-20).
--
-- On 2026-10-17 the Asana webhook and the cron reached the same comment within
-- a second of each other, both saw no reply yet, and every reply went up twice.
-- qa-runner now inserts the comment's story gid here before replying; the
-- primary key makes the insert the lock, and whoever loses it stays quiet.
-- Service role only: no policies, RLS on.

create table if not exists public.qa_comment_replies (
  story_gid text primary key,
  task_gid text,
  created_at timestamptz not null default now()
);

alter table public.qa_comment_replies enable row level security;

comment on table public.qa_comment_replies is
  'Comments Promo QA has replied to: the primary key stops two runs answering the same comment.';

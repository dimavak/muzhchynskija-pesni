-- Прапановы правак ад наведвальнікаў сайта.
-- Як накаціць: Supabase → праект pesni → SQL Editor → New query → уставіць увесь файл → Run.
-- Файл можна запускаць паўторна: ён нічога не выдаляе.
--
-- Схема бяспекі:
--   * чужыя (роля anon) не бачаць і не мяняюць табліцу наўпрост: RLS уключаны, правілаў для anon няма;
--   * праўку можна толькі дадаць праз функцыю submit_correction(), якая правярае даўжыні,
--     поле-пастку для ботаў і ліміты (з аднаго адраса і агулам за суткі);
--   * адрас наведвальніка не захоўваецца, толькі яго хэш з сакрэтнай соллю (для ліміту).
-- Праглядаць і мяняць статус: Table Editor → corrections (панэль працуе ад імя ўладальніка).

create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists private.secret (
  id   boolean primary key default true check (id),
  salt text not null default encode(extensions.gen_random_bytes(24), 'hex')
);
insert into private.secret default values on conflict do nothing;

create table if not exists public.corrections (
  id             bigint generated always as identity primary key,
  created_at     timestamptz not null default now(),
  status         text not null default 'новая'
                 check (status in ('новая', 'прынята', 'выпраўлена', 'адхілена')),
  song_id        text not null check (song_id ~ '^[0-9]{1,5}[a-zа-я]?$'),
  section        text not null default 'main' check (section in ('main', '18')),
  kind           text not null check (kind in ('text', 'notes', 'place', 'translation', 'other')),
  script         text check (script in ('cyr', 'lat')),
  line_no        int check (line_no between 1 and 2000),
  quote          text check (char_length(quote) <= 1000),
  context_before text check (char_length(context_before) <= 200),
  context_after  text check (char_length(context_after) <= 200),
  suggestion     text check (char_length(suggestion) <= 2000),
  comment        text check (char_length(comment) <= 3000),
  author_name    text check (char_length(author_name) <= 100),
  author_email   text check (char_length(author_email) <= 200),
  ui_lang        text check (ui_lang in ('be', 'pl', 'en')),
  page_url       text check (char_length(page_url) <= 500),
  ip_hash        text,
  admin_note     text,
  reviewed_at    timestamptz
);
comment on table public.corrections is 'Прапановы правак ад наведвальнікаў сайта. Статус: новая → прынята → выпраўлена, або адхілена.';
create index if not exists corrections_status_idx on public.corrections (status, created_at desc);
create index if not exists corrections_ip_idx on public.corrections (ip_hash, created_at desc);

alter table public.corrections enable row level security;
revoke all on table public.corrections from anon, authenticated;

-- калі мяняецца статус, сама ставіцца дата прагляду
create or replace function private.touch_reviewed() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.status is distinct from old.status then new.reviewed_at := now(); end if;
  return new;
end $$;
drop trigger if exists corrections_reviewed on public.corrections;
create trigger corrections_reviewed before update on public.corrections
  for each row execute function private.touch_reviewed();

create or replace function public.submit_correction(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  hdr  json := coalesce(nullif(current_setting('request.headers', true), ''), '{}')::json;
  ip   text := coalesce(hdr->>'cf-connecting-ip', split_part(hdr->>'x-forwarded-for', ',', 1), '');
  h    text;
  cut  text;
  r    public.corrections%rowtype;
begin
  -- поле-пастка: людзі яго не бачаць, боты запаўняюць; адказваем «ок» і нічога не пішам
  if coalesce(p->>'website', '') <> '' then return jsonb_build_object('ok', true); end if;

  select encode(digest(trim(ip) || (select salt from private.secret), 'sha256'), 'hex') into h;

  if (select count(*) from public.corrections where ip_hash = h and created_at > now() - interval '1 hour') >= 10
     or (select count(*) from public.corrections where ip_hash = h and created_at > now() - interval '1 day') >= 40 then
    return jsonb_build_object('ok', false, 'error', 'rate');
  end if;
  if (select count(*) from public.corrections where created_at > now() - interval '1 day') >= 500 then
    return jsonb_build_object('ok', false, 'error', 'busy');
  end if;

  r.song_id        := trim(p->>'song_id');
  r.section        := coalesce(nullif(p->>'section', ''), 'main');
  r.kind           := coalesce(nullif(p->>'kind', ''), 'other');
  r.script         := nullif(p->>'script', '');
  r.line_no        := nullif(p->>'line_no', '')::int;
  r.quote          := nullif(left(p->>'quote', 1000), '');
  r.context_before := nullif(left(p->>'context_before', 200), '');
  r.context_after  := nullif(left(p->>'context_after', 200), '');
  r.suggestion     := nullif(trim(p->>'suggestion'), '');
  r.comment        := nullif(trim(p->>'comment'), '');
  r.author_name    := nullif(trim(p->>'author_name'), '');
  r.author_email   := nullif(trim(p->>'author_email'), '');
  r.ui_lang        := nullif(p->>'ui_lang', '');
  r.page_url       := nullif(left(p->>'page_url', 500), '');

  if r.suggestion is null and r.comment is null then
    return jsonb_build_object('ok', false, 'error', 'empty');
  end if;
  if r.author_email is not null and r.author_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    return jsonb_build_object('ok', false, 'error', 'email');
  end if;
  if r.suggestion is not null and r.quote is not null and r.suggestion = r.quote and r.comment is null then
    return jsonb_build_object('ok', false, 'error', 'same');
  end if;

  insert into public.corrections (song_id, section, kind, script, line_no, quote, context_before, context_after,
                                  suggestion, comment, author_name, author_email, ui_lang, page_url, ip_hash)
  values (r.song_id, r.section, r.kind, r.script, r.line_no, r.quote, r.context_before, r.context_after,
          r.suggestion, r.comment, r.author_name, r.author_email, r.ui_lang, r.page_url, h)
  returning id into r.id;
  return jsonb_build_object('ok', true, 'id', r.id);
exception
  when check_violation or invalid_text_representation or numeric_value_out_of_range then
    return jsonb_build_object('ok', false, 'error', 'invalid');
end $$;

revoke all on function public.submit_correction(jsonb) from public;
grant execute on function public.submit_correction(jsonb) to anon, authenticated;

-- для штотыднёвага «пінга» з GitHub Actions, каб бясплатны праект не засынаў
create or replace function public.ping() returns text language sql stable set search_path = '' as $$ select 'ok'::text $$;
revoke all on function public.ping() from public;
grant execute on function public.ping() to anon;

-- Статыстыка наведванняў (без кукі і без старонніх лічыльнікаў).
-- Як накаціць: SQL Editor → New query → уставіць увесь файл → Run. Патрабуе corrections.sql і corrections-2-admin.sql.
-- Файл можна запускаць паўторна.
--
-- Сайт адпраўляе ананімныя падзеі праз track(): адкрыццё старонкі, адкрыццё песні, час на песні, праслухоўванне,
-- актыўны час сесіі. «Наведвальнік» — хэш (адрас + браўзер + дзень + соль), ён мяняецца кожныя суткі,
-- таму асобнага чалавека нельга сачыць паміж днямі. Самі адрасы не захоўваюцца.
-- Чытаць статыстыку можа толькі адміністратар праз stats_summary().

create table if not exists public.events (
  id         bigint generated always as identity primary key,
  ts         timestamptz not null default now(),
  day        date not null default (now() at time zone 'Europe/Warsaw')::date,
  visitor    text not null,
  session    text not null check (char_length(session) between 6 and 40),
  type       text not null check (type in ('view', 'song', 'song_time', 'play', 'end')),
  catalog    text check (catalog in ('men', 'all', '18')),
  page       text check (page in ('home', 'song', 'map', 'other')),
  song_id    text check (song_id ~ '^[0-9]{1,5}[a-zа-я]?$'),
  song_title text check (char_length(song_title) <= 160),
  places     text[] check (cardinality(places) <= 30),
  seconds    int check (seconds between 0 and 86400),
  mode       text check (char_length(mode) <= 20),
  lang       text check (lang in ('be', 'pl', 'en')),
  device     text check (device in ('phone', 'tablet', 'desktop')),
  country    text check (char_length(country) <= 3),
  referrer   text check (char_length(referrer) <= 120)
);
create index if not exists events_day_idx on public.events (day);
create index if not exists events_song_idx on public.events (song_id, day) where song_id is not null;
alter table public.events enable row level security;
revoke all on table public.events from anon, authenticated;

create or replace function public.track(p jsonb)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  hdr json := coalesce(nullif(current_setting('request.headers', true), ''), '{}')::json;
  ip  text := coalesce(hdr->>'cf-connecting-ip', split_part(hdr->>'x-forwarded-for', ',', 1), '');
  d   date := (now() at time zone 'Europe/Warsaw')::date;
  v   text;
begin
  select left(encode(digest(trim(ip) || '|' || coalesce(hdr->>'user-agent', '') || '|' || d || (select salt from private.secret), 'sha256'), 'hex'), 20) into v;
  -- ад аднаго наведвальніка не больш за 3000 падзей у суткі, агулам 300 000
  if (select count(*) from public.events where day = d and visitor = v) >= 3000 then return; end if;
  if (select count(*) from public.events where day = d) >= 300000 then return; end if;
  insert into public.events (day, visitor, session, type, catalog, page, song_id, song_title, places, seconds, mode, lang, device, country, referrer)
  values (d, v, left(p->>'session', 40), p->>'type', nullif(p->>'catalog', ''), nullif(p->>'page', ''), nullif(p->>'song_id', ''),
          nullif(left(p->>'song_title', 160), ''),
          case when jsonb_typeof(p->'places') = 'array' then (select array_agg(left(x, 30)) from (select jsonb_array_elements_text(p->'places') x limit 30) s) end,
          least(greatest((nullif(p->>'seconds', ''))::numeric, 0), 86400)::int, nullif(left(p->>'mode', 20), ''),
          nullif(p->>'lang', ''), nullif(p->>'device', ''),
          nullif(upper(left(coalesce(hdr->>'cf-ipcountry', hdr->>'x-country', ''), 3)), ''),
          nullif(left(lower(p->>'referrer'), 120), ''));
exception
  when check_violation or invalid_text_representation or numeric_value_out_of_range or not_null_violation then return;
end $$;
revoke all on function public.track(jsonb) from public;
grant execute on function public.track(jsonb) to anon, authenticated;

-- Зводка для адмінкі за перыяд [p_from, p_to] і каталог (null = усе)
create or replace function public.stats_summary(p_from date, p_to date, p_catalog text default null)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare res jsonb;
begin
  if not public.is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  with e as (
    select * from public.events where day between p_from and p_to and (p_catalog is null or catalog = p_catalog)
  ), sess as (
    select session, min(day) as day, max(seconds) filter (where type = 'end') as secs,
           count(*) filter (where type = 'song') as songs
      from e group by session
  )
  select jsonb_build_object(
    'totals', (select jsonb_build_object(
        'visitors', (select count(distinct visitor || day) from e),
        'sessions', (select count(*) from sess),
        'views', (select count(*) from e where type = 'view'),
        'songs', (select count(*) from e where type = 'song'),
        'plays', (select count(*) from e where type = 'play'),
        'avg_session', (select round(avg(secs)) from sess where secs > 0),
        'median_session', (select percentile_cont(0.5) within group (order by secs) from sess where secs > 0),
        'avg_songs', (select round(avg(songs), 1) from sess),
        'song_seconds', (select coalesce(sum(seconds), 0) from e where type = 'song_time'))),
    'days', (select coalesce(jsonb_agg(x order by x.day), '[]') from (
        select g::date as day, coalesce(a.visitors, 0) as visitors, coalesce(b.sessions, 0) as sessions, coalesce(a.songs, 0) as songs
          from generate_series(p_from, p_to, interval '1 day') g
          left join (select day, count(distinct visitor) as visitors, count(*) filter (where type = 'song') as songs from e group by day) a on a.day = g::date
          left join (select day, count(*) as sessions from sess group by day) b on b.day = g::date) x),
    'top_songs', (select coalesce(jsonb_agg(x), '[]') from (
        select song_id, max(catalog) as catalog, max(song_title) as title,
               count(*) filter (where type = 'song') as views,
               count(distinct visitor || day) filter (where type = 'song') as visitors,
               coalesce(sum(seconds) filter (where type = 'song_time'), 0) as seconds,
               count(*) filter (where type = 'play') as plays
          from e where song_id is not null group by song_id
         order by views desc, seconds desc limit 50) x),
    'places', (select coalesce(jsonb_object_agg(k, n), '{}') from (
        select k, count(*) as n from e, unnest(e.places) k where e.type = 'song' group by k) x),
    'lang', (select coalesce(jsonb_object_agg(coalesce(lang, '?'), n), '{}') from (select lang, count(distinct session) n from e where type = 'view' group by lang) x),
    'device', (select coalesce(jsonb_object_agg(coalesce(device, '?'), n), '{}') from (select device, count(distinct session) n from e where type = 'view' group by device) x),
    'country', (select coalesce(jsonb_object_agg(coalesce(country, '?'), n), '{}') from (select country, count(distinct session) n from e where type = 'view' group by country) x),
    'catalog', (select coalesce(jsonb_object_agg(coalesce(catalog, '?'), n), '{}') from (select catalog, count(distinct session) n from e where type = 'view' group by catalog) x),
    'referrer', (select coalesce(jsonb_object_agg(r, n), '{}') from (
        select coalesce(referrer, 'наўпрост') r, count(*) n from e where type = 'view' group by 1 order by 2 desc limit 15) x),
    'hours', (select coalesce(jsonb_object_agg(h, n), '{}') from (
        select extract(hour from ts at time zone 'Europe/Warsaw')::int h, count(distinct session) n from e group by 1) x)
  ) into res;
  return res;
end $$;
revoke all on function public.stats_summary(date, date, text) from public, anon;
grant execute on function public.stats_summary(date, date, text) to authenticated;

-- Падзеі старэйшыя за 2 гады выдаляюцца раз на тыдзень разам з пінгам (сам пінг — public.ping()).
create or replace function public.ping() returns text language plpgsql volatile security definer set search_path = '' as $$
begin
  delete from public.events where day < (now() - interval '2 years')::date;
  return 'ok';
end $$;
revoke all on function public.ping() from public;
grant execute on function public.ping() to anon;

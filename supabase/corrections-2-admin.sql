-- Крок 2: старонка адміністратара (admin.html) і мацнейшая ахова ад спаму.
-- Як накаціць: спачатку Authentication → Users → Add user → Create new user (ваш email, Auto Confirm User),
-- потым SQL Editor → New query → уставіць увесь файл → Run.
-- Усе карыстальнікі, якія ёсць у праекце на момант запуску, становяцца адміністратарамі.
-- Каб дадаць яшчэ аднаго пазней: стварыць карыстальніка і запусціць гэты файл зноў.
-- Файл можна запускаць паўторна: ён нічога не выдаляе.

-- ---------- адміністратары ----------
create table if not exists private.admins (
  user_id uuid primary key references auth.users (id) on delete cascade
);
insert into private.admins (user_id) select id from auth.users on conflict do nothing;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from private.admins where user_id = auth.uid())
$$;
revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- адміністратар бачыць праўкі і можа мяняць толькі статус, прапанову і нататку
grant select on public.corrections to authenticated;
grant update (status, suggestion, admin_note) on public.corrections to authenticated;
drop policy if exists corrections_admin_read on public.corrections;
create policy corrections_admin_read on public.corrections for select to authenticated using (public.is_admin());
drop policy if exists corrections_admin_update on public.corrections;
create policy corrections_admin_update on public.corrections for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ---------- блакаванне аўтараў ----------
create table if not exists private.blocked (
  ip_hash    text primary key,
  created_at timestamptz not null default now(),
  note       text
);

-- «Заблакаваць аўтара»: яго новыя праўкі адхіляюцца, наступныя з таго ж адраса ціха ігнаруюцца
create or replace function public.block_author(p_id bigint) returns int
language plpgsql security definer set search_path = '' as $$
declare h text; n int;
begin
  if not public.is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  select ip_hash into h from public.corrections where id = p_id;
  if h is null then return 0; end if;
  insert into private.blocked (ip_hash, note) values (h, 'праўка #' || p_id) on conflict do nothing;
  update public.corrections set status = 'адхілена', admin_note = coalesce(admin_note || ' · ', '') || 'аўтар заблакаваны'
   where ip_hash = h and status = 'новая';
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.block_author(bigint) from public, anon;
grant execute on function public.block_author(bigint) to authenticated;

-- адмяніць блакаванне (напрыклад, калі ў спамера і ў добрага чалавека аказаўся агульны адрас)
create or replace function public.unblock_author(p_id bigint) returns int
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  if not public.is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  delete from private.blocked b using public.corrections c where c.id = p_id and b.ip_hash = c.ip_hash;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.unblock_author(bigint) from public, anon;
grant execute on function public.unblock_author(bigint) to authenticated;

-- для адмінкі: якія з паказаных правак ад заблакаваных аўтараў
create or replace function public.blocked_ids(p_ids bigint[]) returns setof bigint
language sql stable security definer set search_path = '' as $$
  select c.id from public.corrections c join private.blocked b on b.ip_hash = c.ip_hash
   where public.is_admin() and c.id = any (p_ids)
$$;
revoke all on function public.blocked_ids(bigint[]) from public, anon;
grant execute on function public.blocked_ids(bigint[]) to authenticated;

-- ---------- прыём правак з дадатковымі праверкамі ----------
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
  r    public.corrections%rowtype;
  silent constant jsonb := jsonb_build_object('ok', true);
begin
  -- поле-пастка і занадта хуткая адпраўка (людзі за 3 секунды форму не запаўняюць): «ок», але нічога не пішам
  if coalesce(p->>'website', '') <> '' then return silent; end if;
  if (p->>'elapsed_ms') ~ '^\d+$' and (p->>'elapsed_ms')::bigint < 3000 then return silent; end if;

  select encode(digest(trim(ip) || (select salt from private.secret), 'sha256'), 'hex') into h;
  if exists (select 1 from private.blocked where ip_hash = h) then return silent; end if;

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
  -- спасылкі ў праўках не патрэбныя, а спамеры іх любяць
  if concat_ws(' ', r.suggestion, r.comment, r.author_name) ~* '(https?://|www\.|\m[a-z0-9-]+\.(com|ru|net|org|info|xyz|top|io|biz)\M)' then
    return jsonb_build_object('ok', false, 'error', 'links');
  end if;
  -- той самы тэкст той самай праўкі за апошнія 30 дзён: не дубліруем
  if exists (select 1 from public.corrections c where c.song_id = r.song_id and c.section = r.section
               and c.quote is not distinct from r.quote and c.suggestion is not distinct from r.suggestion
               and c.comment is not distinct from r.comment and c.created_at > now() - interval '30 days') then
    return silent;
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

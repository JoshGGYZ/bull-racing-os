-- Bull Racing OS - banco compartilhado, permissoes e historico
-- Execute este arquivo uma vez no SQL Editor do projeto Supabase.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
    id uuid primary key references auth.users(id) on delete cascade,
    email text not null default '',
    display_name text not null default '',
    role text not null default 'viewer' check (role in ('admin', 'editor', 'viewer')),
    active boolean not null default false,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists public.team_state (
    team_id text primary key,
    data jsonb not null default '{}'::jsonb,
    version bigint not null default 1 check (version > 0),
    updated_at timestamptz not null default now(),
    updated_by uuid references auth.users(id) on delete set null
);

create table if not exists public.team_state_history (
    id bigint generated always as identity primary key,
    team_id text not null,
    version bigint not null,
    data jsonb not null,
    saved_at timestamptz not null default now(),
    saved_by uuid references auth.users(id) on delete set null,
    unique (team_id, version)
);

create index if not exists team_state_history_team_version_idx
    on public.team_state_history (team_id, version desc);

alter table public.profiles enable row level security;
alter table public.team_state enable row level security;
alter table public.team_state_history enable row level security;

create or replace function public.current_profile_role()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select role from public.profiles where id = auth.uid() and active = true
$$;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at
before update on public.profiles
for each row execute function public.touch_updated_at();

-- A primeira conta criada vira administradora. Contas posteriores ficam
-- inativas ate um administrador aprova-las no painel do Supabase.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    is_first boolean;
begin
    perform pg_advisory_xact_lock(84521001);
    select not exists(select 1 from public.profiles) into is_first;

    insert into public.profiles (id, email, display_name, role, active)
    values (
        new.id,
        coalesce(new.email, ''),
        coalesce(new.raw_user_meta_data ->> 'display_name', split_part(coalesce(new.email, ''), '@', 1)),
        case when is_first then 'admin' else 'viewer' end,
        is_first
    )
    on conflict (id) do nothing;
    return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

drop policy if exists profiles_read_self_or_team on public.profiles;
create policy profiles_read_self_or_team on public.profiles
for select to authenticated
using (id = auth.uid() or public.current_profile_role() is not null);

drop policy if exists profiles_admin_update on public.profiles;
create policy profiles_admin_update on public.profiles
for update to authenticated
using (public.current_profile_role() = 'admin')
with check (public.current_profile_role() = 'admin');

drop policy if exists team_state_read_active on public.team_state;
create policy team_state_read_active on public.team_state
for select to authenticated
using (public.current_profile_role() is not null and team_id = 'bull-racing');

drop policy if exists history_read_admin on public.team_state_history;
create policy history_read_admin on public.team_state_history
for select to authenticated
using (public.current_profile_role() = 'admin' and team_id = 'bull-racing');

-- Salvamento atomico com versao otimista. Se dois computadores tentarem
-- salvar a mesma versao, apenas o primeiro vence e o segundo recebe conflito.
create or replace function public.save_team_state(
    p_team_id text,
    p_expected_version bigint,
    p_data jsonb
)
returns table(saved boolean, new_version bigint, current_version bigint)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_role text;
    v_current bigint;
    v_next bigint;
begin
    v_role := public.current_profile_role();
    if v_role is null or v_role not in ('admin', 'editor') then
        raise exception 'Usuario sem permissao de edicao' using errcode = '42501';
    end if;
    if p_team_id <> 'bull-racing' then
        raise exception 'Equipe invalida' using errcode = '22023';
    end if;
    if p_data is null or jsonb_typeof(p_data) <> 'object' then
        raise exception 'Estado invalido' using errcode = '22023';
    end if;
    if pg_column_size(p_data) > 5242880 then
        raise exception 'Estado excede o limite de 5 MB' using errcode = '54000';
    end if;

    perform pg_advisory_xact_lock(hashtext(p_team_id));
    select version into v_current from public.team_state where team_id = p_team_id;

    if v_current is null then
        if coalesce(p_expected_version, 0) <> 0 then
            return query select false, 0::bigint, 0::bigint;
            return;
        end if;
        v_next := 1;
        insert into public.team_state (team_id, data, version, updated_by)
        values (p_team_id, p_data, v_next, auth.uid());
    else
        if v_current <> coalesce(p_expected_version, 0) then
            return query select false, v_current, v_current;
            return;
        end if;
        v_next := v_current + 1;
        update public.team_state
        set data = p_data, version = v_next, updated_at = now(), updated_by = auth.uid()
        where team_id = p_team_id;
    end if;

    insert into public.team_state_history (team_id, version, data, saved_by)
    values (p_team_id, v_next, p_data, auth.uid());

    -- Mantem as 100 versoes mais recentes para recuperacao sem crescimento infinito.
    delete from public.team_state_history h
    where h.team_id = p_team_id
      and h.id not in (
          select id from public.team_state_history
          where team_id = p_team_id
          order by version desc
          limit 100
      );

    return query select true, v_next, v_next;
end;
$$;

revoke all on function public.save_team_state(text, bigint, jsonb) from public, anon;
grant execute on function public.save_team_state(text, bigint, jsonb) to authenticated;
grant usage on schema public to authenticated;
grant select on public.profiles, public.team_state to authenticated;
grant select on public.team_state_history to authenticated;

comment on table public.team_state is 'Estado compartilhado atual do Bull Racing OS';
comment on table public.team_state_history is 'Ultimas 100 versoes para auditoria e recuperacao';


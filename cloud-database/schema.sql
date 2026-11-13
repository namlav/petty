-- ============================================================
-- petty - Cloud Database (Supabase / PostgreSQL)
-- Chạy trong Supabase SQL Editor (hoặc psql) theo thứ tự:
--   1) schema.sql
--   2) rls_rbac_policies.sql
-- ============================================================

create extension if not exists pgcrypto;

-- ---------- Vai trò người dùng (RBAC) ----------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'user_role') then
    create type public.user_role as enum ('admin', 'owner', 'viewer', 'device');
  end if;
end $$;

create table if not exists public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  email      text,
  role       public.user_role not null default 'viewer',
  created_at timestamptz not null default now()
);

-- Tự tạo profile khi có user mới (Supabase Auth).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, role)
  values (new.id, new.email, 'viewer')
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- Thiết bị ----------
create table if not exists public.devices (
  id             text primary key,                -- "esp01"
  owner_id       uuid references auth.users (id) on delete set null,
  name           text not null default 'Pet Feeder',
  online         boolean not null default false,
  last_seen      timestamptz,
  portion_grams  numeric(6, 1) not null default 30.0,
  bowl_weight_g  numeric(6, 1) not null default 0,
  food_level     smallint not null default 100 check (food_level between 0 and 100),
  created_at     timestamptz not null default now()
);

-- ---------- Lịch hẹn cho ăn (Cron) ----------
create table if not exists public.feeding_schedules (
  id           bigint generated always as identity primary key,
  device_id    text not null references public.devices (id) on delete cascade,
  hour         smallint not null check (hour between 0 and 23),
  minute       smallint not null check (minute between 0 and 59),
  target_grams numeric(6, 1) not null default 30.0 check (target_grams > 0),
  enabled      boolean not null default true,
  created_by   uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now()
);

create index if not exists feeding_schedules_device_idx
  on public.feeding_schedules (device_id, enabled);

-- ---------- Time-series telemetry ----------
create table if not exists public.telemetry_logs (
  id          bigint generated always as identity primary key,
  device_id   text not null references public.devices (id) on delete cascade,
  seq_num     bigint not null,
  recorded_at timestamptz not null,
  weight_g    numeric(7, 1) not null default 0,
  food_level  smallint not null default 0 check (food_level between 0 and 100),
  status      smallint not null default 0,   -- 0 Idle, 1 Feeding, 2 Offline-Synced, 3 Error
  error_code  smallint not null default 0,   -- 0 OK, 1 Jammed, 2 Empty Tank, 3 Sensor Fault
  synced      boolean not null default false,
  raw         jsonb,
  created_at  timestamptz not null default now(),
  -- Chống ghi trùng khi ESP32 đồng bộ lại Ring Buffer sau khi mất mạng.
  constraint telemetry_logs_device_seq_key unique (device_id, seq_num)
);

create index if not exists telemetry_logs_device_time_idx
  on public.telemetry_logs (device_id, recorded_at desc);

-- Cập nhật trạng thái thiết bị mỗi khi có telemetry mới.
create or replace function public.touch_device_on_telemetry()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.devices
     set last_seen = new.recorded_at,
         online = true,
         bowl_weight_g = new.weight_g,
         food_level = new.food_level
   where id = new.device_id;
  return new;
end $$;

drop trigger if exists telemetry_touch_device on public.telemetry_logs;
create trigger telemetry_touch_device
  after insert on public.telemetry_logs
  for each row execute function public.touch_device_on_telemetry();

-- ---------- Hàng đợi lệnh (pg_cron / dashboard) ----------
create table if not exists public.device_commands (
  id           bigint generated always as identity primary key,
  device_id    text not null references public.devices (id) on delete cascade,
  command      text not null,                       -- FEED / STOP / SET_SCHEDULE
  payload      jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  delivered_at timestamptz
);

create index if not exists device_commands_pending_idx
  on public.device_commands (device_id, delivered_at);

-- ---------- Dữ liệu mẫu ----------
insert into public.devices (id, name, portion_grams)
values ('esp01', 'Pet Feeder - esp01', 30.0)
on conflict (id) do nothing;

insert into public.feeding_schedules (device_id, hour, minute, target_grams, enabled)
values ('esp01', 7, 30, 30.0, false)
on conflict do nothing;

-- ============================================================
-- pg_cron: kích hoạt lịch cho ăn miễn phí (Supabase Free Tier)
-- Bật extension tại Dashboard -> Database -> Extensions -> pg_cron.
-- Mỗi phút quét lịch khớp giờ (Asia/Ho_Chi_Minh) và đẩy lệnh vào hàng đợi.
-- ============================================================
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if exists (select 1 from cron.job where jobname = 'petty-feeding-schedule') then
      perform cron.unschedule('petty-feeding-schedule');
    end if;
    perform cron.schedule(
      'petty-feeding-schedule',
      '* * * * *',
      $cron$
        insert into public.device_commands (device_id, command, payload)
        select s.device_id, 'FEED', jsonb_build_object('g', s.target_grams)
          from public.feeding_schedules s
         where s.enabled
           and s.hour = extract(hour from (now() at time zone 'Asia/Ho_Chi_Minh'))
           and s.minute = extract(minute from (now() at time zone 'Asia/Ho_Chi_Minh'));
      $cron$
    );
    raise notice 'pg_cron: da dang ky job petty-feeding-schedule';
  else
    raise notice 'pg_cron chua bat - bo qua buoc tao lich tu dong';
  end if;
end $$;

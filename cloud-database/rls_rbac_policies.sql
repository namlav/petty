-- ============================================================
-- petty - Row Level Security & RBAC
-- Vai trò: admin | owner | viewer | device
--   admin  : toàn quyền hệ thống
--   owner  : thiết bị mình sở hữu + lịch ăn của thiết bị đó
--   viewer : chỉ đọc trạng thái / biểu đồ
--   device : chỉ được ghi telemetry của chính nó (gateway dùng service key
--            nên thực tế bypass RLS; policy này dành cho thiết bị dùng JWT)
-- Chạy sau schema.sql.
-- ============================================================

alter table public.profiles enable row level security;
alter table public.devices enable row level security;
alter table public.feeding_schedules enable row level security;
alter table public.telemetry_logs enable row level security;
alter table public.device_commands enable row level security;

-- ---------- Hàm hỗ trợ ----------
-- Vai trò ứng dụng lấy từ profiles, fallback về claim JWT ("role").
create or replace function public.current_role_name()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select p.role::text from public.profiles p where p.id = auth.uid()),
    (auth.jwt() ->> 'role')
  );
$$;

create or replace function public.owns_device(p_device_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.devices d
     where d.id = p_device_id
       and d.owner_id = auth.uid()
  );
$$;

-- ---------- profiles ----------
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select using (
    public.current_role_name() = 'admin' or id = auth.uid()
  );

drop policy if exists profiles_admin_write on public.profiles;
create policy profiles_admin_write on public.profiles
  for all using (public.current_role_name() = 'admin')
  with check (public.current_role_name() = 'admin');

-- ---------- devices ----------
drop policy if exists devices_select on public.devices;
create policy devices_select on public.devices
  for select using (
    public.current_role_name() in ('admin', 'viewer') or owner_id = auth.uid()
  );

drop policy if exists devices_owner_write on public.devices;
create policy devices_owner_write on public.devices
  for all using (
    public.current_role_name() = 'admin' or owner_id = auth.uid()
  )
  with check (
    public.current_role_name() = 'admin' or owner_id = auth.uid()
  );

-- ---------- feeding_schedules ----------
drop policy if exists schedules_select on public.feeding_schedules;
create policy schedules_select on public.feeding_schedules
  for select using (
    public.current_role_name() in ('admin', 'viewer')
    or public.owns_device(device_id)
  );

drop policy if exists schedules_owner_write on public.feeding_schedules;
create policy schedules_owner_write on public.feeding_schedules
  for all using (
    public.current_role_name() = 'admin' or public.owns_device(device_id)
  )
  with check (
    public.current_role_name() = 'admin' or public.owns_device(device_id)
  );

-- ---------- telemetry_logs (time-series) ----------
drop policy if exists telemetry_select on public.telemetry_logs;
create policy telemetry_select on public.telemetry_logs
  for select using (
    public.current_role_name() in ('admin', 'viewer')
    or public.owns_device(device_id)
  );

-- Thiết bị chỉ được ghi telemetry của chính nó.
drop policy if exists telemetry_device_insert on public.telemetry_logs;
create policy telemetry_device_insert on public.telemetry_logs
  for insert with check (
    public.current_role_name() = 'device'
    and device_id = coalesce(auth.jwt() ->> 'device_id', '')
  );

-- Không cho sửa/xoá telemetry đã ghi (time-series append-only).
drop policy if exists telemetry_no_update on public.telemetry_logs;
create policy telemetry_no_update on public.telemetry_logs
  for update using (false);

drop policy if exists telemetry_no_delete on public.telemetry_logs;
create policy telemetry_no_delete on public.telemetry_logs
  for delete using (public.current_role_name() = 'admin');

-- ---------- device_commands ----------
drop policy if exists commands_select on public.device_commands;
create policy commands_select on public.device_commands
  for select using (
    public.current_role_name() in ('admin', 'viewer')
    or public.owns_device(device_id)
  );

drop policy if exists commands_owner_insert on public.device_commands;
create policy commands_owner_insert on public.device_commands
  for insert with check (
    public.current_role_name() = 'admin' or public.owns_device(device_id)
  );

drop policy if exists commands_deliver on public.device_commands;
create policy commands_deliver on public.device_commands
  for update using (
    public.current_role_name() = 'admin'
    or public.owns_device(device_id)
    or public.current_role_name() = 'device'
  )
  with check (
    public.current_role_name() = 'admin'
    or public.owns_device(device_id)
    or public.current_role_name() = 'device'
  );

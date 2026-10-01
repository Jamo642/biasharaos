-- Biashara OS PostgreSQL/Supabase schema.
-- This mirrors the local MVP database and is ready for Supabase migrations.

create extension if not exists "pgcrypto";

create table companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  city text not null,
  created_at timestamptz not null default now()
);

create table users (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  name text not null,
  phone text not null unique,
  role text not null check (role in ('OWNER','MANAGER','SUPERVISOR','STOREKEEPER','OPERATOR','TECHNICIAN','ACCOUNTANT')),
  created_at timestamptz not null default now()
);

create table products (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  sku text not null,
  name text not null,
  unit text not null,
  selling_price numeric(12,2) not null default 0,
  created_at timestamptz not null default now()
);

create table materials (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  name text not null,
  unit text not null,
  supplier text,
  reorder_level numeric(12,3) not null default 0,
  created_at timestamptz not null default now()
);

create table inventory (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  item_type text not null check (item_type in ('RAW_MATERIAL','WIP','FINISHED_GOOD')),
  item_id uuid not null,
  item_name text not null,
  unit text not null,
  quantity numeric(12,3) not null default 0,
  reorder_level numeric(12,3) not null default 0,
  updated_at timestamptz not null default now()
);

create table inventory_transactions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  inventory_id uuid not null references inventory(id),
  action text not null,
  quantity numeric(12,3) not null,
  before_qty numeric(12,3) not null,
  after_qty numeric(12,3) not null,
  source text not null,
  user_id uuid references users(id),
  production_job_id uuid,
  note text,
  created_at timestamptz not null default now()
);

create table production_jobs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  job_no text not null,
  product_id uuid not null references products(id),
  product_name text not null,
  target_qty numeric(12,3) not null,
  completed_qty numeric(12,3) not null default 0,
  status text not null check (status in ('PENDING','IN_PROGRESS','COMPLETED','DELAYED')),
  operator_id uuid references users(id),
  due_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table production_entries (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  production_job_id uuid references production_jobs(id),
  product_id uuid not null references products(id),
  product_name text not null,
  quantity_produced numeric(12,3) not null,
  operator_id uuid references users(id),
  source text not null,
  original_message text,
  structured_json jsonb,
  created_at timestamptz not null default now()
);

create table machines (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  machine_no text not null,
  name text not null,
  location text not null,
  status text not null check (status in ('RUNNING','IDLE','DOWN','MAINTENANCE')),
  current_operator_id uuid references users(id),
  technician_id uuid references users(id),
  last_maintenance date,
  next_maintenance date,
  total_downtime_minutes numeric(12,2) not null default 0,
  updated_at timestamptz not null default now()
);

create table downtime_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  machine_id uuid not null references machines(id),
  status text not null,
  reported_by uuid references users(id),
  technician_id uuid references users(id),
  acknowledged_at timestamptz,
  resolved_at timestamptz,
  downtime_minutes numeric(12,2),
  escalation_level integer not null default 0,
  source text not null,
  original_message text,
  created_at timestamptz not null default now()
);

create table maintenance_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  machine_id uuid not null references machines(id),
  event_type text not null,
  note text,
  technician_id uuid references users(id),
  created_at timestamptz not null default now()
);

create table customers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  name text not null,
  phone text,
  created_at timestamptz not null default now()
);

create table orders (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  order_no text not null,
  customer_id uuid not null references customers(id),
  status text not null,
  total_amount numeric(12,2) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  product_id uuid not null references products(id),
  product_name text not null,
  quantity numeric(12,3) not null,
  unit_price numeric(12,2) not null
);

create table invoices (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  invoice_no text not null,
  order_id uuid not null references orders(id),
  amount numeric(12,2) not null,
  status text not null check (status in ('UNPAID','PAID','VOID')),
  issued_at timestamptz not null default now(),
  paid_at timestamptz
);

create table payments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  invoice_id uuid not null references invoices(id),
  provider text not null,
  amount numeric(12,2) not null,
  reference text not null,
  status text not null,
  raw_payload jsonb,
  created_at timestamptz not null default now()
);

create table suppliers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  name text not null,
  phone text,
  email text,
  created_at timestamptz not null default now()
);

create table expenses (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  category text not null,
  description text,
  amount numeric(12,2) not null,
  user_id uuid references users(id),
  source text not null,
  created_at timestamptz not null default now()
);

create table customer_debts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  customer_id uuid not null references customers(id),
  sale_id uuid,
  amount_owed numeric(12,2) not null,
  amount_paid numeric(12,2) not null default 0,
  status text not null,
  due_date date,
  created_at timestamptz not null default now()
);

create table supplier_debts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  supplier_id uuid not null references suppliers(id),
  purchase_id uuid,
  amount_owed numeric(12,2) not null,
  amount_paid numeric(12,2) not null default 0,
  status text not null,
  due_date date,
  created_at timestamptz not null default now()
);

create table debt_payments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  debt_id uuid not null,
  debt_type text not null,
  amount numeric(12,2) not null,
  payment_method text not null,
  reference text,
  user_id uuid references users(id),
  created_at timestamptz not null default now()
);

create table alerts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  type text not null,
  severity text not null,
  title text not null,
  message text not null,
  status text not null,
  assigned_user_id uuid references users(id),
  entity_type text,
  entity_id uuid,
  created_at timestamptz not null default now(),
  acknowledged_at timestamptz
);

create table notifications (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  channel text not null,
  recipient text not null,
  message text not null,
  status text not null,
  provider text not null,
  provider_ref text,
  created_at timestamptz not null default now()
);

create table ai_conversations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  user_id uuid references users(id),
  channel text not null,
  message text not null,
  response text not null,
  created_at timestamptz not null default now()
);

create table ai_actions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  conversation_id uuid references ai_conversations(id),
  intent text not null,
  structured_json jsonb not null,
  requires_confirmation boolean not null default false,
  confirmed boolean not null default true,
  status text not null,
  created_at timestamptz not null default now()
);

create table audit_logs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  actor_user_id uuid references users(id),
  action text not null,
  entity_type text,
  entity_id uuid,
  before_json jsonb,
  after_json jsonb,
  source text not null,
  created_at timestamptz not null default now()
);

alter table companies enable row level security;
alter table users enable row level security;
alter table products enable row level security;
alter table materials enable row level security;
alter table inventory enable row level security;
alter table inventory_transactions enable row level security;
alter table production_jobs enable row level security;
alter table production_entries enable row level security;
alter table machines enable row level security;
alter table downtime_events enable row level security;
alter table maintenance_events enable row level security;
alter table customers enable row level security;
alter table orders enable row level security;
alter table order_items enable row level security;
alter table invoices enable row level security;
alter table payments enable row level security;
alter table alerts enable row level security;
alter table notifications enable row level security;
alter table ai_conversations enable row level security;
alter table ai_actions enable row level security;
alter table audit_logs enable row level security;

-- Application policies should bind auth.jwt()->>'company_id' and auth.jwt()->>'role'
-- to company_id and role permissions. The MVP keeps this schema explicit so Supabase
-- RLS policies can be added without changing application data structures.

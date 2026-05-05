create extension if not exists pgcrypto;

create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  psid text not null unique,
  full_name text,
  phone text,
  address text,
  last_product text,
  last_product_notes text,
  last_intent text,
  conversation_summary text,
  order_status text default 'not_started',
  human_handoff boolean not null default false,
  price_given_at timestamptz,
  last_customer_message_at timestamptz,
  last_language_style text,
  followup_1_sent boolean not null default false,
  followup_1_sent_at timestamptz,
  followup_2_sent boolean not null default false,
  followup_2_sent_at timestamptz,
  followup_3_sent boolean not null default false,
  followup_3_sent_at timestamptz,
  last_followup_angle text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table if exists public.customers add column if not exists last_product_notes text;
alter table if exists public.customers add column if not exists price_given_at timestamptz;
alter table if exists public.customers add column if not exists last_customer_message_at timestamptz;
alter table if exists public.customers add column if not exists last_language_style text;
alter table if exists public.customers add column if not exists followup_1_sent boolean not null default false;
alter table if exists public.customers add column if not exists followup_1_sent_at timestamptz;
alter table if exists public.customers add column if not exists followup_2_sent boolean not null default false;
alter table if exists public.customers add column if not exists followup_2_sent_at timestamptz;
alter table if exists public.customers add column if not exists followup_3_sent boolean not null default false;
alter table if exists public.customers add column if not exists followup_3_sent_at timestamptz;
alter table if exists public.customers add column if not exists last_followup_angle text;

create table if not exists public.messages (
  id bigint generated always as identity primary key,
  psid text not null,
  role text not null check (role in ('user', 'assistant')),
  message_text text not null,
  metadata jsonb,
  created_at timestamptz not null default now(),
  constraint messages_psid_fk foreign key (psid) references public.customers (psid) on delete cascade
);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  psid text not null,
  customer_name text not null,
  phone text not null,
  address text not null,
  product_name text not null,
  quantity integer not null check (quantity > 0),
  order_status text not null default 'pending_confirmation',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint orders_psid_fk foreign key (psid) references public.customers (psid) on delete cascade
);

create index if not exists idx_customers_psid on public.customers (psid);
create index if not exists idx_messages_psid_created_at on public.messages (psid, created_at desc);
create index if not exists idx_orders_psid_created_at on public.orders (psid, created_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_customers_updated_at on public.customers;
create trigger trg_customers_updated_at
before update on public.customers
for each row
execute function public.set_updated_at();

drop trigger if exists trg_orders_updated_at on public.orders;
create trigger trg_orders_updated_at
before update on public.orders
for each row
execute function public.set_updated_at();

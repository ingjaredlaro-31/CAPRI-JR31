-- ============================================================
-- CAPRI RESTORATION SERVICES INC · ADMINISTRADOR CENTRAL · JR31
-- Pegar TODO en Supabase > SQL Editor > Run
-- ============================================================

create table if not exists usuarios (
  id uuid primary key default gen_random_uuid(),
  username text unique not null,
  nombre text not null,
  rol text not null check (rol in ('admin','oficina','tecnico')),
  departamento text not null default 'restoration' check (departamento in ('restoration','cleaning','ambos')),
  password_hash text not null,
  telefono text,
  activo boolean default true,
  created_at timestamptz default now()
);

create table if not exists contratistas (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  especialidad text,
  telefono text,
  activo boolean default true,
  created_at timestamptz default now()
);

create table if not exists estimados (
  id uuid primary key default gen_random_uuid(),
  folio text unique not null,
  departamento text not null default 'restoration',
  cliente text not null,
  telefono text,
  direccion text,
  descripcion text,
  monto numeric default 0,
  estatus text not null default 'borrador' check (estatus in ('borrador','enviado','aceptado','rechazado')),
  fecha_envio date,
  job_id uuid,
  notas text,
  created_at timestamptz default now()
);

create table if not exists jobs (
  id uuid primary key default gen_random_uuid(),
  folio text unique not null,
  departamento text not null default 'restoration',
  tipo text not null default 'water',
  cliente text not null,
  telefono text,
  direccion text not null,
  ciudad text,
  zip text,
  tipo_propiedad text default 'casa',
  unidad text,
  management text,
  management_tel text,
  propietario text,
  aseguranza text,
  claim_number text,
  adjuster text,
  adjuster_tel text,
  estatus text not null default 'activo',
  fecha_perdida date,
  fecha_inicio date default current_date,
  estimado_id uuid references estimados(id) on delete set null,
  notas text,
  created_at timestamptz default now()
);

alter table estimados drop constraint if exists estimados_job_fk;
alter table estimados add constraint estimados_job_fk
  foreign key (job_id) references jobs(id) on delete set null;

create table if not exists asignaciones (
  id uuid primary key default gen_random_uuid(),
  job_id uuid references jobs(id) on delete cascade,
  tecnico_id uuid references usuarios(id) on delete cascade,
  fecha date not null,
  hora text,
  notas text,
  created_at timestamptz default now(),
  unique (job_id, tecnico_id, fecha)
);

create table if not exists reportes (
  id uuid primary key default gen_random_uuid(),
  job_id uuid references jobs(id) on delete cascade,
  tecnico_id uuid references usuarios(id) on delete set null,
  fecha date not null,
  hora_entrada text,
  hora_salida text,
  trabajo_realizado text,
  deshu_inst int default 0, air_inst int default 0, scrub_inst int default 0,
  deshu_ret int default 0,  air_ret int default 0,  scrub_ret int default 0,
  lecturas jsonb default '[]'::jsonb,
  fotos jsonb default '[]'::jsonb,
  demolido text,
  notas text,
  created_at timestamptz default now(),
  unique (job_id, tecnico_id, fecha)
);

create table if not exists partidas (
  id uuid primary key default gen_random_uuid(),
  job_id uuid references jobs(id) on delete cascade,
  nombre text not null,
  detalle text,
  cantidad text,
  contratista_id uuid references contratistas(id) on delete set null,
  estatus text not null default 'pendiente'
    check (estatus in ('pendiente','asignada','proceso','revision','aprobada')),
  fecha_inicio date,
  fecha_fin date,
  fotos jsonb default '[]'::jsonb,
  created_at timestamptz default now()
);

create table if not exists notas (
  id uuid primary key default gen_random_uuid(),
  job_id uuid references jobs(id) on delete cascade,
  usuario_id uuid references usuarios(id) on delete set null,
  autor text,
  texto text not null,
  created_at timestamptz default now()
);

create table if not exists recordatorios (
  id uuid primary key default gen_random_uuid(),
  job_id uuid references jobs(id) on delete cascade,
  texto text not null,
  fecha_venc date,
  hecho boolean default false,
  created_at timestamptz default now()
);

create index if not exists ix_asig_fecha on asignaciones(fecha);
create index if not exists ix_rep_fecha on reportes(fecha);
create index if not exists ix_part_job on partidas(job_id);

alter table usuarios      enable row level security;
alter table contratistas  enable row level security;
alter table estimados     enable row level security;
alter table jobs          enable row level security;
alter table asignaciones  enable row level security;
alter table reportes      enable row level security;
alter table partidas      enable row level security;
alter table notas         enable row level security;
alter table recordatorios enable row level security;

do $$ declare t text;
begin
  foreach t in array array['usuarios','contratistas','estimados','jobs','asignaciones','reportes','partidas','notas','recordatorios']
  loop
    execute format('drop policy if exists app_all on %I', t);
    execute format('create policy app_all on %I for all using (true) with check (true)', t);
  end loop;
end $$;

-- ---------- USUARIOS INICIALES ----------
-- julio    / Capri2026!    admin (ve los dos departamentos)
-- oficina  / Oficina2026!  oficina
-- tecnico1 / Tecnico2026!  técnico de restoration
insert into usuarios (username, nombre, rol, departamento, password_hash) values
 ('julio','Julio · Admin','admin','ambos','9d05081a9174db57d997821c23e6f0291ccff2bf091eacc7f3d11e410f174855'),
 ('oficina','Oficina','oficina','ambos','f2d5bbba4bd0446cc243a6a07b4132a7b2aebb9557776df8d678d06858395b69'),
 ('tecnico1','Técnico Restoration','tecnico','restoration','b4cc6d4d23f4a2b211e453b0b697bc3895630a997bd241e0d5150e7b95d308d8')
on conflict (username) do nothing;

insert into contratistas (nombre, especialidad) values
 ('JR Drywall','Drywall · baseboards · pintura'),
 ('Pacific Flooring','Piso · vinil · laminado')
on conflict do nothing;

insert into storage.buckets (id, name, public) values ('capri','capri',true)
on conflict (id) do nothing;

drop policy if exists capri_read on storage.objects;
drop policy if exists capri_write on storage.objects;
create policy capri_read  on storage.objects for select using (bucket_id = 'capri');
create policy capri_write on storage.objects for insert with check (bucket_id = 'capri');

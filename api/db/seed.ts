import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { db, queryClient } from './client';
import {
  users,
  trainingTypes,
  planTypes,
  classTemplates,
  clubConfig,
} from './schema';
import { eq } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Datos reales del negocio Fitvang (@fitvang10)
// Cl. 13b #37-86, Barrio El Dorado, Cali · America/Bogota
// ---------------------------------------------------------------------------

const SUPER_ADMIN_EMAIL = process.env.SEED_SUPER_ADMIN_EMAIL ?? 'admin@fitvang.com';
const SUPER_ADMIN_PASSWORD = process.env.SEED_SUPER_ADMIN_PASSWORD ?? 'Fitvang2026!';
const SUPER_ADMIN_DOCUMENTO = process.env.SEED_SUPER_ADMIN_DOCUMENTO ?? '00000000';

const TRAINING_TYPES = [
  {
    slug: 'funcional',
    nombre: 'Entrenamiento Funcional',
    descripcion:
      'El movimiento consciente es la base. Fuerza, resistencia y consciencia en cada ejecución. Sesiones en circuito de 1 hora, siempre con un profe.',
    colorHex: '#3DC4DB',
    icono: 'dumbbell',
    accesoMulti: false,
    ordenVisual: 1,
  },
  {
    slug: 'futbol_funcional',
    nombre: 'Fútbol Funcional',
    descripcion:
      'Preparación física deportiva + físico-cognitivo. Fuerza, resistencia, velocidad, técnica, coordinación y juegos menores tácticos. Mucho fútbol.',
    colorHex: '#4DD4E8',
    icono: 'football',
    accesoMulti: false,
    ordenVisual: 2,
  },
  {
    slug: 'kids',
    nombre: 'Fitvang Kids',
    descripcion:
      'Programa especializado para niños. Entrenamiento funcional y fútbol adaptado a su edad y desarrollo motor.',
    colorHex: '#FF8A3D',
    icono: 'baby',
    accesoMulti: false,
    ordenVisual: 3,
  },
  {
    slug: 'vip',
    nombre: 'Plan VIP',
    descripcion:
      'Acceso ilimitado a Entrenamiento Funcional y Fútbol Funcional. La membresía completa.',
    colorHex: '#FFD43D',
    icono: 'crown',
    accesoMulti: true,
    ordenVisual: 0,
  },
] as const;

// Planes: [trainingSlug, modalidad, precio, nombre]
const PLAN_DEFS = [
  // Funcional
  { trainingSlug: 'funcional', modalidad: 'individual', precio: 85_000, nombre: 'Funcional Individual', min: 1, max: 1 },
  { trainingSlug: 'funcional', modalidad: 'pareja', precio: 75_000, nombre: 'Funcional Pareja', min: 2, max: 2 },
  { trainingSlug: 'funcional', modalidad: 'amigos', precio: 70_000, nombre: 'Funcional Amigos', min: 3, max: null },
  // Fútbol Funcional
  { trainingSlug: 'futbol_funcional', modalidad: 'individual', precio: 125_000, nombre: 'Fútbol Individual', min: 1, max: 1 },
  { trainingSlug: 'futbol_funcional', modalidad: 'pareja', precio: 95_000, nombre: 'Fútbol Pareja', min: 2, max: 2 },
  { trainingSlug: 'futbol_funcional', modalidad: 'amigos', precio: 90_000, nombre: 'Fútbol Amigos', min: 3, max: null },
  // VIP
  { trainingSlug: 'vip', modalidad: 'individual', precio: 170_000, nombre: 'VIP Individual', min: 1, max: 1 },
  { trainingSlug: 'vip', modalidad: 'pareja', precio: 130_000, nombre: 'VIP Pareja', min: 2, max: 2 },
  { trainingSlug: 'vip', modalidad: 'amigos', precio: 115_000, nombre: 'VIP Amigos', min: 3, max: null },
] as const;

// Horarios L–V (1=lunes..5=viernes)
const WEEKDAYS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes'] as const;

// Slots [horaInicio, horaFin]
const FUNCTIONAL_FOOTBALL_SLOTS: Array<[string, string]> = [
  ['06:00:00', '07:00:00'],
  ['07:00:00', '08:00:00'],
  ['18:00:00', '19:00:00'],
  ['19:00:00', '20:00:00'],
];
const KIDS_SLOTS: Array<[string, string]> = [['18:00:00', '19:00:00']];

async function main() {
  console.log('→ Sembrando datos iniciales de Fitvang…');

  // 1) Configuración del club (singleton id=1)
  await db
    .insert(clubConfig)
    .values({
      id: 1,
      nombreClub: 'Fitvang',
      direccion: 'Cl. 13b #37-86, Barrio El Dorado, Cali',
      timezone: 'America/Bogota',
      cancelacionHorasMin: 2,
      wompiSandbox: true,
    })
    .onConflictDoNothing({ target: clubConfig.id });
  console.log('  ✓ club_config');

  // 2) Super Admin
  const passwordHash = await bcrypt.hash(SUPER_ADMIN_PASSWORD, 10);
  const existingAdmin = await db.select().from(users).where(eq(users.email, SUPER_ADMIN_EMAIL)).limit(1);
  let adminId: string;
  if (existingAdmin.length > 0) {
    adminId = existingAdmin[0].id;
    console.log(`  ↻ super_admin ya existe (${SUPER_ADMIN_EMAIL})`);
  } else {
    const [admin] = await db
      .insert(users)
      .values({
        nombreCompleto: 'Super Admin Fitvang',
        documento: SUPER_ADMIN_DOCUMENTO,
        email: SUPER_ADMIN_EMAIL,
        passwordHash,
        rol: 'super_admin',
        activo: true,
      })
      .returning({ id: users.id });
    adminId = admin.id;
    console.log(`  ✓ super_admin creado (${SUPER_ADMIN_EMAIL} / ${SUPER_ADMIN_PASSWORD})`);
  }

  // 3) Training Types
  const trainingIds: Record<string, string> = {};
  for (const tt of TRAINING_TYPES) {
    const existing = await db.select().from(trainingTypes).where(eq(trainingTypes.slug, tt.slug)).limit(1);
    if (existing.length > 0) {
      trainingIds[tt.slug] = existing[0].id;
    } else {
      const [row] = await db.insert(trainingTypes).values(tt).returning({ id: trainingTypes.id });
      trainingIds[tt.slug] = row.id;
    }
  }
  console.log(`  ✓ training_types (${Object.keys(trainingIds).length})`);

  // 4) Plan Types
  let plansCreated = 0;
  for (const p of PLAN_DEFS) {
    const trainingTypeId = trainingIds[p.trainingSlug];
    const exists = await db
      .select({ id: planTypes.id })
      .from(planTypes)
      .where(eq(planTypes.nombre, p.nombre))
      .limit(1);
    if (exists.length > 0) continue;
    await db.insert(planTypes).values({
      nombre: p.nombre,
      trainingTypeId,
      modalidad: p.modalidad,
      precioBaseCop: p.precio,
      minPersonas: p.min,
      maxPersonas: p.max,
      duracionDias: 30,
      sesionesIncluidas: null, // ilimitado dentro de su modalidad
      descripcion: `Plan ${p.modalidad} de ${p.nombre}. Precio por persona: $${p.precio.toLocaleString('es-CO')} COP/mes.`,
      activo: true,
    });
    plansCreated++;
  }
  console.log(`  ✓ plan_types (${plansCreated} nuevos)`);

  // 5) Class Templates
  let templatesCreated = 0;
  const insertTemplate = async (
    nombre: string,
    trainingSlug: string,
    dia: (typeof WEEKDAYS)[number],
    horaInicio: string,
    horaFin: string,
    capacidad: number,
  ) => {
    // Evitar duplicados por (training, dia, hora)
    const existing = await db
      .select({ id: classTemplates.id })
      .from(classTemplates)
      .where(eq(classTemplates.nombre, `${nombre} · ${dia} ${horaInicio.slice(0, 5)}`))
      .limit(1);
    if (existing.length > 0) return;
    await db.insert(classTemplates).values({
      nombre: `${nombre} · ${dia} ${horaInicio.slice(0, 5)}`,
      trainingTypeId: trainingIds[trainingSlug],
      diaSemana: dia,
      horaInicio,
      horaFin,
      capacidadMax: capacidad,
      activo: true,
    });
    templatesCreated++;
  };

  for (const dia of WEEKDAYS) {
    for (const [hi, hf] of FUNCTIONAL_FOOTBALL_SLOTS) {
      await insertTemplate('Funcional', 'funcional', dia, hi, hf, 20);
      await insertTemplate('Fútbol Funcional', 'futbol_funcional', dia, hi, hf, 22);
    }
    for (const [hi, hf] of KIDS_SLOTS) {
      await insertTemplate('Fitvang Kids', 'kids', dia, hi, hf, 18);
    }
  }
  console.log(`  ✓ class_templates (${templatesCreated} nuevos)`);

  console.log('✓ Seed completado.');
  await queryClient.end({ timeout: 5 });
}

main().catch(async (err) => {
  console.error('✗ Seed falló:', err);
  await queryClient.end({ timeout: 5 }).catch(() => {});
  process.exit(1);
});

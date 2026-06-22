import {
  pgTable,
  pgEnum,
  uuid,
  text,
  varchar,
  boolean,
  integer,
  bigint,
  numeric,
  timestamp,
  date,
  time,
  jsonb,
  uniqueIndex,
  index,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const roleEnum = pgEnum('role', ['super_admin', 'coach', 'user']);
export const genderEnum = pgEnum('gender', ['masculino', 'femenino', 'otro', 'prefiero_no_decir']);
export const guardianRelEnum = pgEnum('guardian_relation', ['padre', 'madre', 'tutor', 'otro']);
export const planModalityEnum = pgEnum('plan_modality', ['individual', 'pareja', 'amigos']);
export const userPlanStatusEnum = pgEnum('user_plan_status', ['activo', 'vencido', 'pausado', 'cancelado']);
export const weekdayEnum = pgEnum('weekday', ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo']);
export const sessionStatusEnum = pgEnum('session_status', ['programada', 'en_progreso', 'finalizada', 'cancelada']);
export const bookingStatusEnum = pgEnum('booking_status', ['activa', 'cancelada', 'no_asistio', 'asistio']);
export const cancelledByEnum = pgEnum('cancelled_by', ['usuario', 'sistema', 'admin', 'coach']);
export const paymentMethodEnum = pgEnum('payment_method', ['wompi_card', 'wompi_nequi', 'wompi_pse', 'efectivo']);
export const paymentStatusEnum = pgEnum('payment_status', ['pendiente', 'exitoso', 'fallido', 'reembolsado']);
export const notificationTypeEnum = pgEnum('notification_type', [
  'asistencia',
  'pago_ok',
  'pago_fail',
  'pago_efectivo',
  'plan_vence',
  'plan_vencido',
  'reserva',
  'reserva_cancelada',
  'cupo_disponible',
  'clase_cancelada',
  'bienvenida',
  'sistema',
]);
export const scoringLevelEnum = pgEnum('scoring_level', ['rookie', 'regular', 'constante', 'elite', 'leyenda']);

// ---------------------------------------------------------------------------
// Tablas
// ---------------------------------------------------------------------------

export const users = pgTable(
  'users',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    nombreCompleto: varchar('nombre_completo', { length: 200 }).notNull(),
    documento: varchar('documento', { length: 40 }).notNull(),
    email: varchar('email', { length: 200 }).notNull(),
    telefono: varchar('telefono', { length: 40 }),
    passwordHash: text('password_hash').notNull(),
    rol: roleEnum('rol').notNull().default('user'),
    avatarUrl: text('avatar_url'),
    fechaNacimiento: date('fecha_nacimiento'),
    genero: genderEnum('genero'),
    esMenor: boolean('es_menor').notNull().default(false),
    pesoKg: numeric('peso_kg', { precision: 5, scale: 1 }),
    alturaCm: integer('altura_cm'),
    bio: text('bio'),
    activo: boolean('activo').notNull().default(true),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    emailIdx: uniqueIndex('users_email_idx').on(t.email),
    documentoIdx: uniqueIndex('users_documento_idx').on(t.documento),
    rolIdx: index('users_rol_idx').on(t.rol),
  })
);

export const coaches = pgTable('coaches', {
  id: uuid('id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  especialidad: varchar('especialidad', { length: 200 }),
  bio: text('bio'),
  activo: boolean('activo').notNull().default(true),
});

export const guardians = pgTable(
  'guardians',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    menorId: uuid('menor_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    acudienteId: uuid('acudiente_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    relacion: guardianRelEnum('relacion').notNull().default('otro'),
    esResponsablePago: boolean('es_responsable_pago').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqRel: uniqueIndex('guardians_menor_acudiente_idx').on(t.menorId, t.acudienteId),
    menorIdx: index('guardians_menor_idx').on(t.menorId),
    acudienteIdx: index('guardians_acudiente_idx').on(t.acudienteId),
  })
);

export const trainingTypes = pgTable('training_types', {
  id: uuid('id').defaultRandom().primaryKey(),
  slug: varchar('slug', { length: 40 }).notNull().unique(),
  nombre: varchar('nombre', { length: 100 }).notNull(),
  descripcion: text('descripcion'),
  colorHex: varchar('color_hex', { length: 9 }).default('#3DC4DB'),
  icono: varchar('icono', { length: 40 }),
  accesoMulti: boolean('acceso_multi').notNull().default(false),
  activo: boolean('activo').notNull().default(true),
  ordenVisual: integer('orden_visual').notNull().default(0),
});

export const planTypes = pgTable(
  'plan_types',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    nombre: varchar('nombre', { length: 120 }).notNull(),
    trainingTypeId: uuid('training_type_id')
      .notNull()
      .references(() => trainingTypes.id, { onDelete: 'restrict' }),
    modalidad: planModalityEnum('modalidad').notNull(),
    precioBaseCop: bigint('precio_base_cop', { mode: 'number' }).notNull(),
    minPersonas: integer('min_personas').notNull().default(1),
    maxPersonas: integer('max_personas'),
    duracionDias: integer('duracion_dias').notNull().default(30),
    sesionesIncluidas: integer('sesiones_incluidas'), // null = ilimitado
    descripcion: text('descripcion'),
    beneficios: jsonb('beneficios').$type<string[]>().default([]),
    activo: boolean('activo').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    trainingIdx: index('plan_types_training_idx').on(t.trainingTypeId),
  })
);

export const planGroups = pgTable('plan_groups', {
  id: uuid('id').defaultRandom().primaryKey(),
  planTypeId: uuid('plan_type_id')
    .notNull()
    .references(() => planTypes.id, { onDelete: 'restrict' }),
  nombreGrupo: varchar('nombre_grupo', { length: 120 }),
  descuentoEspecialCop: bigint('descuento_especial_cop', { mode: 'number' }).notNull().default(0),
  activo: boolean('activo').notNull().default(true),
  creadoPor: uuid('creado_por').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const userPlans = pgTable(
  'user_plans',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    planTypeId: uuid('plan_type_id')
      .notNull()
      .references(() => planTypes.id, { onDelete: 'restrict' }),
    planGroupId: uuid('plan_group_id').references(() => planGroups.id, { onDelete: 'set null' }),
    precioCopAplicado: bigint('precio_cop_aplicado', { mode: 'number' }).notNull(),
    fechaInicio: date('fecha_inicio').notNull(),
    fechaFin: date('fecha_fin').notNull(),
    sesionesTotales: integer('sesiones_totales'),
    sesionesUsadas: integer('sesiones_usadas').notNull().default(0),
    estado: userPlanStatusEnum('estado').notNull().default('activo'),
    creadoPor: uuid('creado_por').references(() => users.id, { onDelete: 'set null' }),
    notasAdmin: text('notas_admin'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index('user_plans_user_idx').on(t.userId),
    estadoIdx: index('user_plans_estado_idx').on(t.estado),
    finIdx: index('user_plans_fin_idx').on(t.fechaFin),
  })
);

export const classTemplates = pgTable(
  'class_templates',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    nombre: varchar('nombre', { length: 120 }).notNull(),
    trainingTypeId: uuid('training_type_id')
      .notNull()
      .references(() => trainingTypes.id, { onDelete: 'restrict' }),
    coachId: uuid('coach_id').references(() => coaches.id, { onDelete: 'set null' }),
    diaSemana: weekdayEnum('dia_semana').notNull(),
    horaInicio: time('hora_inicio').notNull(),
    horaFin: time('hora_fin').notNull(),
    capacidadMax: integer('capacidad_max').notNull().default(20),
    activo: boolean('activo').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    trainingIdx: index('class_templates_training_idx').on(t.trainingTypeId),
    diaIdx: index('class_templates_dia_idx').on(t.diaSemana),
  })
);

export const classSessions = pgTable(
  'class_sessions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    templateId: uuid('template_id')
      .notNull()
      .references(() => classTemplates.id, { onDelete: 'cascade' }),
    fecha: date('fecha').notNull(),
    coachOverrideId: uuid('coach_override_id').references(() => coaches.id, { onDelete: 'set null' }),
    estado: sessionStatusEnum('estado').notNull().default('programada'),
    cancelacionMotivo: text('cancelacion_motivo'),
    canceladaPor: uuid('cancelada_por').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqTemplFecha: uniqueIndex('class_sessions_template_fecha_idx').on(t.templateId, t.fecha),
    fechaIdx: index('class_sessions_fecha_idx').on(t.fecha),
  })
);

export const bookings = pgTable(
  'bookings',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => classSessions.id, { onDelete: 'cascade' }),
    estado: bookingStatusEnum('estado').notNull().default('activa'),
    fechaReserva: timestamp('fecha_reserva', { withTimezone: true }).notNull().defaultNow(),
    canceladaPor: cancelledByEnum('cancelada_por'),
    canceladaAt: timestamp('cancelada_at', { withTimezone: true }),
  },
  (t) => ({
    uniqUserSession: uniqueIndex('bookings_user_session_idx').on(t.userId, t.sessionId),
    sessionIdx: index('bookings_session_idx').on(t.sessionId),
    estadoIdx: index('bookings_estado_idx').on(t.estado),
  })
);

export const attendances = pgTable(
  'attendances',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    bookingId: uuid('booking_id')
      .notNull()
      .unique()
      .references(() => bookings.id, { onDelete: 'cascade' }),
    presente: boolean('presente').notNull(),
    marcadoPor: uuid('marcado_por')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    marcadoAt: timestamp('marcado_at', { withTimezone: true }).notNull().defaultNow(),
  }
);

export const payments = pgTable(
  'payments',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    userPlanId: uuid('user_plan_id').references(() => userPlans.id, { onDelete: 'set null' }),
    planGroupId: uuid('plan_group_id').references(() => planGroups.id, { onDelete: 'set null' }),
    montoCop: bigint('monto_cop', { mode: 'number' }).notNull(),
    metodo: paymentMethodEnum('metodo').notNull(),
    estado: paymentStatusEnum('estado').notNull().default('pendiente'),
    referenciaExterna: varchar('referencia_externa', { length: 200 }),
    notas: text('notas'),
    registradoPor: uuid('registrado_por').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index('payments_user_idx').on(t.userId),
    estadoIdx: index('payments_estado_idx').on(t.estado),
    refIdx: uniqueIndex('payments_referencia_idx').on(t.referenciaExterna),
  })
);

export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    endpoint: text('endpoint').notNull(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    activa: boolean('activa').notNull().default(true),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqEndpoint: uniqueIndex('push_subs_endpoint_idx').on(t.endpoint),
    userIdx: index('push_subs_user_idx').on(t.userId),
  })
);

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tipo: notificationTypeEnum('tipo').notNull(),
    titulo: varchar('titulo', { length: 200 }).notNull(),
    mensaje: text('mensaje').notNull(),
    leida: boolean('leida').notNull().default(false),
    pushSent: boolean('push_sent').notNull().default(false),
    deepLinkUrl: text('deep_link_url'),
    // dedupeKey: clave única sparse — evita doble disparo entre reinicios de cron.
    // Formato: 'inactividad-{userId}-{semanaISO}', 'vencimiento-{planId}-{fecha}', etc.
    dedupeKey: text('dedupe_key').unique(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userLeidaIdx: index('notifications_user_leida_idx').on(t.userId, t.leida),
    createdIdx: index('notifications_created_idx').on(t.createdAt),
  })
);

export const waitlist = pgTable(
  'waitlist',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => classSessions.id, { onDelete: 'cascade' }),
    posicion: integer('posicion').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqUserSession: uniqueIndex('waitlist_user_session_idx').on(t.userId, t.sessionId),
    sessionPosIdx: index('waitlist_session_pos_idx').on(t.sessionId, t.posicion),
  })
);

export const attendanceScoring = pgTable(
  'attendance_scoring',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    mes: varchar('mes', { length: 7 }).notNull(), // YYYY-MM
    totalSesiones: integer('total_sesiones').notNull().default(0),
    asistencias: integer('asistencias').notNull().default(0),
    porcentaje: integer('porcentaje').notNull().default(0),
    rachaActual: integer('racha_actual').notNull().default(0),
    rachaMaxima: integer('racha_maxima').notNull().default(0),
    nivel: scoringLevelEnum('nivel').notNull().default('rookie'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.mes] }),
  })
);

export const clubConfig = pgTable('club_config', {
  id: integer('id').primaryKey().default(1),
  nombreClub: varchar('nombre_club', { length: 120 }).notNull().default('Fitvang'),
  direccion: text('direccion').notNull().default('Cl. 13b #37-86, Barrio El Dorado, Cali'),
  timezone: varchar('timezone', { length: 60 }).notNull().default('America/Bogota'),
  logoUrl: text('logo_url'),
  cancelacionHorasMin: integer('cancelacion_horas_min').notNull().default(2),
  wompiSandbox: boolean('wompi_sandbox').notNull().default(true),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  // ck constraint para forzar singleton (id=1) lo manejamos en migración manual si se requiere
});

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revoked: boolean('revoked').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index('refresh_tokens_user_idx').on(t.userId),
  })
);

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const usersRelations = relations(users, ({ one, many }) => ({
  coach: one(coaches, { fields: [users.id], references: [coaches.id] }),
  plans: many(userPlans),
  bookings: many(bookings),
  payments: many(payments),
  notifications: many(notifications),
  pushSubs: many(pushSubscriptions),
  guardiansAsMinor: many(guardians, { relationName: 'minor' }),
  guardiansAsGuardian: many(guardians, { relationName: 'guardian' }),
}));

export const coachesRelations = relations(coaches, ({ one, many }) => ({
  user: one(users, { fields: [coaches.id], references: [users.id] }),
  templates: many(classTemplates),
}));

export const guardiansRelations = relations(guardians, ({ one }) => ({
  menor: one(users, { fields: [guardians.menorId], references: [users.id], relationName: 'minor' }),
  acudiente: one(users, { fields: [guardians.acudienteId], references: [users.id], relationName: 'guardian' }),
}));

export const trainingTypesRelations = relations(trainingTypes, ({ many }) => ({
  planTypes: many(planTypes),
  classTemplates: many(classTemplates),
}));

export const planTypesRelations = relations(planTypes, ({ one, many }) => ({
  trainingType: one(trainingTypes, { fields: [planTypes.trainingTypeId], references: [trainingTypes.id] }),
  userPlans: many(userPlans),
  groups: many(planGroups),
}));

export const planGroupsRelations = relations(planGroups, ({ one, many }) => ({
  planType: one(planTypes, { fields: [planGroups.planTypeId], references: [planTypes.id] }),
  miembros: many(userPlans),
}));

export const userPlansRelations = relations(userPlans, ({ one, many }) => ({
  user: one(users, { fields: [userPlans.userId], references: [users.id] }),
  planType: one(planTypes, { fields: [userPlans.planTypeId], references: [planTypes.id] }),
  planGroup: one(planGroups, { fields: [userPlans.planGroupId], references: [planGroups.id] }),
  payments: many(payments),
}));

export const classTemplatesRelations = relations(classTemplates, ({ one, many }) => ({
  trainingType: one(trainingTypes, { fields: [classTemplates.trainingTypeId], references: [trainingTypes.id] }),
  coach: one(coaches, { fields: [classTemplates.coachId], references: [coaches.id] }),
  sessions: many(classSessions),
}));

export const classSessionsRelations = relations(classSessions, ({ one, many }) => ({
  template: one(classTemplates, { fields: [classSessions.templateId], references: [classTemplates.id] }),
  coachOverride: one(coaches, { fields: [classSessions.coachOverrideId], references: [coaches.id] }),
  bookings: many(bookings),
  waitlist: many(waitlist),
}));

export const bookingsRelations = relations(bookings, ({ one }) => ({
  user: one(users, { fields: [bookings.userId], references: [users.id] }),
  session: one(classSessions, { fields: [bookings.sessionId], references: [classSessions.id] }),
  attendance: one(attendances, { fields: [bookings.id], references: [attendances.bookingId] }),
}));

export const attendancesRelations = relations(attendances, ({ one }) => ({
  booking: one(bookings, { fields: [attendances.bookingId], references: [bookings.id] }),
  marcadoPor: one(users, { fields: [attendances.marcadoPor], references: [users.id] }),
}));

export const paymentsRelations = relations(payments, ({ one }) => ({
  user: one(users, { fields: [payments.userId], references: [users.id] }),
  userPlan: one(userPlans, { fields: [payments.userPlanId], references: [userPlans.id] }),
  planGroup: one(planGroups, { fields: [payments.planGroupId], references: [planGroups.id] }),
  registradoPor: one(users, { fields: [payments.registradoPor], references: [users.id] }),
}));

export const notificationsRelations = relations(notifications, ({ one }) => ({
  user: one(users, { fields: [notifications.userId], references: [users.id] }),
}));

export const pushSubscriptionsRelations = relations(pushSubscriptions, ({ one }) => ({
  user: one(users, { fields: [pushSubscriptions.userId], references: [users.id] }),
}));

export const waitlistRelations = relations(waitlist, ({ one }) => ({
  user: one(users, { fields: [waitlist.userId], references: [users.id] }),
  session: one(classSessions, { fields: [waitlist.sessionId], references: [classSessions.id] }),
}));

export const refreshTokensRelations = relations(refreshTokens, ({ one }) => ({
  user: one(users, { fields: [refreshTokens.userId], references: [users.id] }),
}));

// Helper type exports
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type TrainingType = typeof trainingTypes.$inferSelect;
export type PlanType = typeof planTypes.$inferSelect;
export type UserPlan = typeof userPlans.$inferSelect;
export type ClassTemplate = typeof classTemplates.$inferSelect;
export type ClassSession = typeof classSessions.$inferSelect;
export type Booking = typeof bookings.$inferSelect;
export type Payment = typeof payments.$inferSelect;
export type Notification = typeof notifications.$inferSelect;

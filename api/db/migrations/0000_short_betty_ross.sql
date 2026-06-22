CREATE TYPE "public"."booking_status" AS ENUM('activa', 'cancelada', 'no_asistio', 'asistio');--> statement-breakpoint
CREATE TYPE "public"."cancelled_by" AS ENUM('usuario', 'sistema', 'admin', 'coach');--> statement-breakpoint
CREATE TYPE "public"."gender" AS ENUM('masculino', 'femenino', 'otro', 'prefiero_no_decir');--> statement-breakpoint
CREATE TYPE "public"."guardian_relation" AS ENUM('padre', 'madre', 'tutor', 'otro');--> statement-breakpoint
CREATE TYPE "public"."notification_type" AS ENUM('asistencia', 'pago_ok', 'pago_fail', 'pago_efectivo', 'plan_vence', 'plan_vencido', 'reserva', 'reserva_cancelada', 'cupo_disponible', 'clase_cancelada', 'bienvenida', 'sistema');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('wompi_card', 'wompi_nequi', 'wompi_pse', 'efectivo');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('pendiente', 'exitoso', 'fallido', 'reembolsado');--> statement-breakpoint
CREATE TYPE "public"."plan_modality" AS ENUM('individual', 'pareja', 'amigos');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('super_admin', 'coach', 'user');--> statement-breakpoint
CREATE TYPE "public"."scoring_level" AS ENUM('rookie', 'regular', 'constante', 'elite', 'leyenda');--> statement-breakpoint
CREATE TYPE "public"."session_status" AS ENUM('programada', 'en_progreso', 'finalizada', 'cancelada');--> statement-breakpoint
CREATE TYPE "public"."user_plan_status" AS ENUM('activo', 'vencido', 'pausado', 'cancelado');--> statement-breakpoint
CREATE TYPE "public"."weekday" AS ENUM('lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo');--> statement-breakpoint
CREATE TABLE "attendance_scoring" (
	"user_id" uuid NOT NULL,
	"mes" varchar(7) NOT NULL,
	"total_sesiones" integer DEFAULT 0 NOT NULL,
	"asistencias" integer DEFAULT 0 NOT NULL,
	"porcentaje" integer DEFAULT 0 NOT NULL,
	"racha_actual" integer DEFAULT 0 NOT NULL,
	"racha_maxima" integer DEFAULT 0 NOT NULL,
	"nivel" "scoring_level" DEFAULT 'rookie' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attendance_scoring_user_id_mes_pk" PRIMARY KEY("user_id","mes")
);
--> statement-breakpoint
CREATE TABLE "attendances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"presente" boolean NOT NULL,
	"marcado_por" uuid NOT NULL,
	"marcado_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attendances_booking_id_unique" UNIQUE("booking_id")
);
--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"estado" "booking_status" DEFAULT 'activa' NOT NULL,
	"fecha_reserva" timestamp with time zone DEFAULT now() NOT NULL,
	"cancelada_por" "cancelled_by",
	"cancelada_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "class_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" uuid NOT NULL,
	"fecha" date NOT NULL,
	"coach_override_id" uuid,
	"estado" "session_status" DEFAULT 'programada' NOT NULL,
	"cancelacion_motivo" text,
	"cancelada_por" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "class_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nombre" varchar(120) NOT NULL,
	"training_type_id" uuid NOT NULL,
	"coach_id" uuid,
	"dia_semana" "weekday" NOT NULL,
	"hora_inicio" time NOT NULL,
	"hora_fin" time NOT NULL,
	"capacidad_max" integer DEFAULT 20 NOT NULL,
	"activo" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "club_config" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"nombre_club" varchar(120) DEFAULT 'Fitvang' NOT NULL,
	"direccion" text DEFAULT 'Cl. 13b #37-86, Barrio El Dorado, Cali' NOT NULL,
	"timezone" varchar(60) DEFAULT 'America/Bogota' NOT NULL,
	"logo_url" text,
	"cancelacion_horas_min" integer DEFAULT 2 NOT NULL,
	"wompi_sandbox" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coaches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"especialidad" varchar(200),
	"bio" text,
	"activo" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guardians" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"menor_id" uuid NOT NULL,
	"acudiente_id" uuid NOT NULL,
	"relacion" "guardian_relation" DEFAULT 'otro' NOT NULL,
	"es_responsable_pago" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"tipo" "notification_type" NOT NULL,
	"titulo" varchar(200) NOT NULL,
	"mensaje" text NOT NULL,
	"leida" boolean DEFAULT false NOT NULL,
	"deep_link_url" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"user_plan_id" uuid,
	"plan_group_id" uuid,
	"monto_cop" bigint NOT NULL,
	"metodo" "payment_method" NOT NULL,
	"estado" "payment_status" DEFAULT 'pendiente' NOT NULL,
	"referencia_externa" varchar(200),
	"notas" text,
	"registrado_por" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plan_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_type_id" uuid NOT NULL,
	"nombre_grupo" varchar(120),
	"descuento_especial_cop" bigint DEFAULT 0 NOT NULL,
	"activo" boolean DEFAULT true NOT NULL,
	"creado_por" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plan_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nombre" varchar(120) NOT NULL,
	"training_type_id" uuid NOT NULL,
	"modalidad" "plan_modality" NOT NULL,
	"precio_base_cop" bigint NOT NULL,
	"min_personas" integer DEFAULT 1 NOT NULL,
	"max_personas" integer,
	"duracion_dias" integer DEFAULT 30 NOT NULL,
	"sesiones_incluidas" integer,
	"descripcion" text,
	"beneficios" jsonb DEFAULT '[]'::jsonb,
	"activo" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"activa" boolean DEFAULT true NOT NULL,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refresh_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "training_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(40) NOT NULL,
	"nombre" varchar(100) NOT NULL,
	"descripcion" text,
	"color_hex" varchar(9) DEFAULT '#3DC4DB',
	"icono" varchar(40),
	"acceso_multi" boolean DEFAULT false NOT NULL,
	"activo" boolean DEFAULT true NOT NULL,
	"orden_visual" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "training_types_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "user_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"plan_type_id" uuid NOT NULL,
	"plan_group_id" uuid,
	"precio_cop_aplicado" bigint NOT NULL,
	"fecha_inicio" date NOT NULL,
	"fecha_fin" date NOT NULL,
	"sesiones_totales" integer,
	"sesiones_usadas" integer DEFAULT 0 NOT NULL,
	"estado" "user_plan_status" DEFAULT 'activo' NOT NULL,
	"creado_por" uuid,
	"notas_admin" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nombre_completo" varchar(200) NOT NULL,
	"documento" varchar(40) NOT NULL,
	"email" varchar(200) NOT NULL,
	"telefono" varchar(40),
	"password_hash" text NOT NULL,
	"rol" "role" DEFAULT 'user' NOT NULL,
	"avatar_url" text,
	"fecha_nacimiento" date,
	"genero" "gender",
	"es_menor" boolean DEFAULT false NOT NULL,
	"activo" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "waitlist" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"posicion" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attendance_scoring" ADD CONSTRAINT "attendance_scoring_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendances" ADD CONSTRAINT "attendances_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendances" ADD CONSTRAINT "attendances_marcado_por_users_id_fk" FOREIGN KEY ("marcado_por") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_session_id_class_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."class_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_sessions" ADD CONSTRAINT "class_sessions_template_id_class_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."class_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_sessions" ADD CONSTRAINT "class_sessions_coach_override_id_coaches_id_fk" FOREIGN KEY ("coach_override_id") REFERENCES "public"."coaches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_sessions" ADD CONSTRAINT "class_sessions_cancelada_por_users_id_fk" FOREIGN KEY ("cancelada_por") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_templates" ADD CONSTRAINT "class_templates_training_type_id_training_types_id_fk" FOREIGN KEY ("training_type_id") REFERENCES "public"."training_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_templates" ADD CONSTRAINT "class_templates_coach_id_coaches_id_fk" FOREIGN KEY ("coach_id") REFERENCES "public"."coaches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coaches" ADD CONSTRAINT "coaches_id_users_id_fk" FOREIGN KEY ("id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardians" ADD CONSTRAINT "guardians_menor_id_users_id_fk" FOREIGN KEY ("menor_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardians" ADD CONSTRAINT "guardians_acudiente_id_users_id_fk" FOREIGN KEY ("acudiente_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_user_plan_id_user_plans_id_fk" FOREIGN KEY ("user_plan_id") REFERENCES "public"."user_plans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_plan_group_id_plan_groups_id_fk" FOREIGN KEY ("plan_group_id") REFERENCES "public"."plan_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_registrado_por_users_id_fk" FOREIGN KEY ("registrado_por") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_groups" ADD CONSTRAINT "plan_groups_plan_type_id_plan_types_id_fk" FOREIGN KEY ("plan_type_id") REFERENCES "public"."plan_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_groups" ADD CONSTRAINT "plan_groups_creado_por_users_id_fk" FOREIGN KEY ("creado_por") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_types" ADD CONSTRAINT "plan_types_training_type_id_training_types_id_fk" FOREIGN KEY ("training_type_id") REFERENCES "public"."training_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_plans" ADD CONSTRAINT "user_plans_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_plans" ADD CONSTRAINT "user_plans_plan_type_id_plan_types_id_fk" FOREIGN KEY ("plan_type_id") REFERENCES "public"."plan_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_plans" ADD CONSTRAINT "user_plans_plan_group_id_plan_groups_id_fk" FOREIGN KEY ("plan_group_id") REFERENCES "public"."plan_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_plans" ADD CONSTRAINT "user_plans_creado_por_users_id_fk" FOREIGN KEY ("creado_por") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist" ADD CONSTRAINT "waitlist_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist" ADD CONSTRAINT "waitlist_session_id_class_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."class_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bookings_user_session_idx" ON "bookings" USING btree ("user_id","session_id");--> statement-breakpoint
CREATE INDEX "bookings_session_idx" ON "bookings" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "bookings_estado_idx" ON "bookings" USING btree ("estado");--> statement-breakpoint
CREATE UNIQUE INDEX "class_sessions_template_fecha_idx" ON "class_sessions" USING btree ("template_id","fecha");--> statement-breakpoint
CREATE INDEX "class_sessions_fecha_idx" ON "class_sessions" USING btree ("fecha");--> statement-breakpoint
CREATE INDEX "class_templates_training_idx" ON "class_templates" USING btree ("training_type_id");--> statement-breakpoint
CREATE INDEX "class_templates_dia_idx" ON "class_templates" USING btree ("dia_semana");--> statement-breakpoint
CREATE UNIQUE INDEX "guardians_menor_acudiente_idx" ON "guardians" USING btree ("menor_id","acudiente_id");--> statement-breakpoint
CREATE INDEX "guardians_menor_idx" ON "guardians" USING btree ("menor_id");--> statement-breakpoint
CREATE INDEX "guardians_acudiente_idx" ON "guardians" USING btree ("acudiente_id");--> statement-breakpoint
CREATE INDEX "notifications_user_leida_idx" ON "notifications" USING btree ("user_id","leida");--> statement-breakpoint
CREATE INDEX "notifications_created_idx" ON "notifications" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "payments_user_idx" ON "payments" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "payments_estado_idx" ON "payments" USING btree ("estado");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_referencia_idx" ON "payments" USING btree ("referencia_externa");--> statement-breakpoint
CREATE INDEX "plan_types_training_idx" ON "plan_types" USING btree ("training_type_id");--> statement-breakpoint
CREATE UNIQUE INDEX "push_subs_endpoint_idx" ON "push_subscriptions" USING btree ("endpoint");--> statement-breakpoint
CREATE INDEX "push_subs_user_idx" ON "push_subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "refresh_tokens_user_idx" ON "refresh_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_plans_user_idx" ON "user_plans" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_plans_estado_idx" ON "user_plans" USING btree ("estado");--> statement-breakpoint
CREATE INDEX "user_plans_fin_idx" ON "user_plans" USING btree ("fecha_fin");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_idx" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "users_documento_idx" ON "users" USING btree ("documento");--> statement-breakpoint
CREATE INDEX "users_rol_idx" ON "users" USING btree ("rol");--> statement-breakpoint
CREATE UNIQUE INDEX "waitlist_user_session_idx" ON "waitlist" USING btree ("user_id","session_id");--> statement-breakpoint
CREATE INDEX "waitlist_session_pos_idx" ON "waitlist" USING btree ("session_id","posicion");
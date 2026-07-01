// Vango — agente IA de Fitvang.
// Dos experiencias según el rol del usuario autenticado:
//  - Usuarios (cliente/menor/acudiente): tips de fitness, info del club y SOLO
//    sus propios datos vía tools (privacidad estricta — nunca datos de otros).
//  - Admin: acceso a toda la data del club + enviar notificaciones.
// Proveedores OpenAI-compatibles: Groq (rápido) con DeepSeek de respaldo.

import { eq, and, gte, lte, desc, inArray, ilike, sql } from 'drizzle-orm';
import { format, addDays, startOfWeek } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';
import { db } from '../db/client';
import {
  userPlans, planTypes, trainingTypes, bookings, classSessions, classTemplates,
  payments, users, classTemplatePlans,
} from '../db/schema';
import { computeUserScoring } from './scoring.service';
import { notifyUser } from './webpush.service';
import { env } from './../lib/env';

const TZ = 'America/Bogota';
const todayStr = () => format(toZonedTime(new Date(), TZ), 'yyyy-MM-dd');

export interface AgentUser {
  sub: string;
  rol: 'super_admin' | 'coach' | 'user';
  nombre: string;
}
type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: any[];
  tool_call_id?: string;
  name?: string;
};

// ── Definiciones de tools (formato OpenAI) ──────────────────────────────────
const USER_TOOLS = [
  { type: 'function', function: { name: 'mis_planes', description: 'Planes activos del usuario actual: nombre, entrenamiento, fechas y precio.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'mis_reservas', description: 'Próximas reservas del usuario actual (clase, fecha y hora).', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'mi_scoring', description: 'Resumen de asistencia del usuario: % del mes, racha y nivel.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'mis_pagos', description: 'Historial de pagos del usuario (monto, método, estado, fecha).', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'clases_disponibles', description: 'Clases de esta semana a las que el usuario puede acceder según su(s) plan(es).', parameters: { type: 'object', properties: {} } } },
];

const ADMIN_TOOLS = [
  { type: 'function', function: { name: 'reservas_por_fecha', description: 'Quiénes están reservados en una fecha (y opcionalmente una hora). Devuelve nombres.', parameters: { type: 'object', properties: { fecha: { type: 'string', description: 'YYYY-MM-DD' }, hora: { type: 'string', description: 'HH:MM opcional' } }, required: ['fecha'] } } },
  { type: 'function', function: { name: 'pagos_estado', description: 'Pagos por estado (pendiente/exitoso). Devuelve quién pagó o quién debe, con montos.', parameters: { type: 'object', properties: { estado: { type: 'string', enum: ['pendiente', 'exitoso', 'fallido'] } }, required: ['estado'] } } },
  { type: 'function', function: { name: 'resumen_financiero', description: 'Resumen financiero de un mes: ingresos confirmados, pendientes y conteos.', parameters: { type: 'object', properties: { mes: { type: 'string', description: 'YYYY-MM (por defecto el mes actual)' } } } } },
  { type: 'function', function: { name: 'preparar_notificacion', description: 'Prepara un BORRADOR de notificación push y calcula a cuántos/quiénes llegaría. NO envía nada. Úsala SIEMPRE antes de enviar, para mostrarle el borrador al admin y que confirme.', parameters: { type: 'object', properties: { titulo: { type: 'string' }, mensaje: { type: 'string' }, audiencia: { type: 'string', enum: ['todos', 'usuarios'], description: "'todos' = todos los miembros activos; 'usuarios' = solo los usuarioIds indicados" }, usuarioIds: { type: 'array', items: { type: 'string' }, description: 'IDs de usuarios (de buscar_usuario) cuando audiencia="usuarios"' } }, required: ['titulo', 'mensaje', 'audiencia'] } } },
  { type: 'function', function: { name: 'enviar_notificacion', description: 'Envía la notificación push. SOLO úsala DESPUÉS de haber mostrado el borrador con preparar_notificacion y de que el admin confirme explícitamente el envío en un mensaje. Usa el mismo titulo, mensaje y audiencia del borrador.', parameters: { type: 'object', properties: { titulo: { type: 'string' }, mensaje: { type: 'string' }, audiencia: { type: 'string', enum: ['todos', 'usuarios'] }, usuarioIds: { type: 'array', items: { type: 'string' } } }, required: ['titulo', 'mensaje', 'audiencia'] } } },
  { type: 'function', function: { name: 'buscar_usuario', description: 'Busca usuarios por nombre parcial o aproximado. Devuelve id y nombre. Úsalo ANTES de pedir el detalle de un usuario.', parameters: { type: 'object', properties: { nombre: { type: 'string' } }, required: ['nombre'] } } },
  { type: 'function', function: { name: 'detalle_usuario', description: 'Datos de un usuario por su id: planes activos, scoring, próximas reservas y últimos pagos.', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'usuarios_inactivos', description: 'Miembros que no han asistido en los últimos N días (default 30), con su última asistencia.', parameters: { type: 'object', properties: { dias: { type: 'number' } } } } },
];

// Resuelve los destinatarios de una notificación según la audiencia pedida.
// 'todos' = miembros activos con rol user; 'usuarios' = solo los IDs indicados.
async function resolveDestinatarios(
  args: any,
): Promise<{ audiencia: 'todos' | 'usuarios'; rows: { id: string; nombre: string }[]; error?: string }> {
  const audiencia: 'todos' | 'usuarios' = args?.audiencia === 'usuarios' ? 'usuarios' : 'todos';
  if (audiencia === 'usuarios') {
    const ids = Array.isArray(args?.usuarioIds) ? args.usuarioIds.map(String).filter(Boolean) : [];
    if (ids.length === 0) return { audiencia, rows: [], error: 'Falta indicar a qué usuarios va dirigida (usa buscar_usuario para obtener sus IDs).' };
    const rows = await db
      .select({ id: users.id, nombre: users.nombreCompleto })
      .from(users)
      .where(and(eq(users.activo, true), inArray(users.id, ids)));
    return { audiencia, rows };
  }
  const rows = await db
    .select({ id: users.id, nombre: users.nombreCompleto })
    .from(users)
    .where(and(eq(users.rol, 'user'), eq(users.activo, true)));
  return { audiencia, rows };
}

// Candado anti-envío-prematuro: solo autoriza enviar_notificacion si el texto del
// mensaje ya se mostró en un mensaje del asistente en un turno ANTERIOR (el borrador
// ya se le presentó al admin y este respondió). Bloquea enviar sin borrador previo o
// en el mismo turno en que se prepara.
function borradorYaConfirmado(history: ChatMessage[], args: any): boolean {
  const mensaje = String(args?.mensaje ?? '').trim();
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const target = norm(mensaje);
  if (target.length < 3) return false;
  return history.some(
    (m) => m.role === 'assistant' && typeof m.content === 'string' && norm(m.content).includes(target),
  );
}

// ── Ejecución de tools ──────────────────────────────────────────────────────
async function execTool(name: string, args: any, u: AgentUser): Promise<unknown> {
  const isAdmin = u.rol === 'super_admin';

  switch (name) {
    case 'mis_planes': {
      const rows = await db
        .select({ plan: planTypes.nombre, entrenamiento: trainingTypes.nombre, fechaInicio: userPlans.fechaInicio, fechaFin: userPlans.fechaFin, precio: userPlans.precioCopAplicado, renovacionAutomatica: userPlans.renovacionAutomatica })
        .from(userPlans)
        .innerJoin(planTypes, eq(userPlans.planTypeId, planTypes.id))
        .innerJoin(trainingTypes, eq(planTypes.trainingTypeId, trainingTypes.id))
        .where(and(eq(userPlans.userId, u.sub), eq(userPlans.estado, 'activo')));
      return rows.length ? rows : 'El usuario no tiene planes activos.';
    }
    case 'mis_reservas': {
      const rows = await db
        .select({ clase: classTemplates.nombre, fecha: classSessions.fecha, horaInicio: classTemplates.horaInicio, horaFin: classTemplates.horaFin })
        .from(bookings)
        .innerJoin(classSessions, eq(bookings.sessionId, classSessions.id))
        .innerJoin(classTemplates, eq(classSessions.templateId, classTemplates.id))
        .where(and(eq(bookings.userId, u.sub), eq(bookings.estado, 'activa'), gte(classSessions.fecha, todayStr())))
        .orderBy(classSessions.fecha, classTemplates.horaInicio)
        .limit(20);
      return rows.length ? rows : 'El usuario no tiene reservas próximas.';
    }
    case 'mi_scoring': {
      const s = await computeUserScoring(u.sub);
      return { porcentajeMes: s.porcentaje, asistencias: s.asistencias, totalReservas: s.totalSesiones, rachaActual: s.rachaActual, rachaMaxima: s.rachaMaxima, nivel: s.nivel };
    }
    case 'mis_pagos': {
      const rows = await db
        .select({ monto: payments.montoCop, metodo: payments.metodo, estado: payments.estado, fecha: payments.createdAt })
        .from(payments)
        .where(eq(payments.userId, u.sub))
        .orderBy(desc(payments.createdAt))
        .limit(10);
      return rows.length ? rows : 'El usuario no tiene pagos registrados.';
    }
    case 'clases_disponibles': {
      const monday = startOfWeek(addDays(new Date(), 0), { weekStartsOn: 1 });
      const from = format(monday, 'yyyy-MM-dd');
      const to = format(addDays(monday, 6), 'yyyy-MM-dd');
      const rows = await db
        .select({ templateId: classSessions.templateId, clase: classTemplates.nombre, fecha: classSessions.fecha, horaInicio: classTemplates.horaInicio })
        .from(classSessions)
        .innerJoin(classTemplates, eq(classSessions.templateId, classTemplates.id))
        .where(and(eq(classTemplates.activo, true), gte(classSessions.fecha, from), lte(classSessions.fecha, to)))
        .orderBy(classSessions.fecha, classTemplates.horaInicio);
      // filtrar por los planes del usuario (class_template_plans)
      const planRows = await db.select({ planTypeId: userPlans.planTypeId }).from(userPlans).where(and(eq(userPlans.userId, u.sub), eq(userPlans.estado, 'activo')));
      const planTypeIds = new Set(planRows.map((r) => r.planTypeId));
      if (planTypeIds.size === 0) return 'El usuario no tiene plan activo; no hay clases disponibles para reservar.';
      const tp = await db.select({ templateId: classTemplatePlans.templateId, planTypeId: classTemplatePlans.planTypeId }).from(classTemplatePlans);
      const restricted = new Set(tp.map((r) => r.templateId));
      const allowed = new Set(tp.filter((r) => planTypeIds.has(r.planTypeId)).map((r) => r.templateId));
      const visibles = rows.filter((r) => !restricted.has(r.templateId) || allowed.has(r.templateId)).map(({ templateId, ...rest }) => rest);
      return visibles.length ? visibles : 'No hay clases disponibles esta semana para el plan del usuario.';
    }

    // ── Admin ──
    case 'reservas_por_fecha': {
      if (!isAdmin) return 'No autorizado.';
      const conds = [eq(classSessions.fecha, String(args.fecha)), inArray(bookings.estado, ['activa', 'asistio'])];
      const rows = await db
        .select({ nombre: users.nombreCompleto, clase: classTemplates.nombre, horaInicio: classTemplates.horaInicio })
        .from(bookings)
        .innerJoin(classSessions, eq(bookings.sessionId, classSessions.id))
        .innerJoin(classTemplates, eq(classSessions.templateId, classTemplates.id))
        .innerJoin(users, eq(bookings.userId, users.id))
        .where(and(...conds))
        .orderBy(classTemplates.horaInicio);
      const filtered = args.hora ? rows.filter((r) => r.horaInicio.startsWith(String(args.hora))) : rows;
      return filtered.length ? filtered : `Nadie reservado el ${args.fecha}${args.hora ? ' a las ' + args.hora : ''}.`;
    }
    case 'pagos_estado': {
      if (!isAdmin) return 'No autorizado.';
      const rows = await db
        .select({ nombre: users.nombreCompleto, monto: payments.montoCop, metodo: payments.metodo, fecha: payments.createdAt })
        .from(payments)
        .innerJoin(users, eq(payments.userId, users.id))
        .where(eq(payments.estado, args.estado))
        .orderBy(desc(payments.createdAt))
        .limit(100);
      return rows.length ? rows : `No hay pagos en estado ${args.estado}.`;
    }
    case 'resumen_financiero': {
      if (!isAdmin) return 'No autorizado.';
      const mes = (args.mes as string) || todayStr().slice(0, 7);
      const ini = `${mes}-01`;
      const fin = `${mes}-31`;
      const [ingresos] = await db
        .select({ total: sql<number>`COALESCE(SUM(${payments.montoCop}),0)::bigint`, n: sql<number>`count(*)::int` })
        .from(payments)
        .where(and(eq(payments.estado, 'exitoso'), gte(sql`${payments.createdAt}::date::text`, ini), lte(sql`${payments.createdAt}::date::text`, fin)));
      const [pendientes] = await db
        .select({ total: sql<number>`COALESCE(SUM(${payments.montoCop}),0)::bigint`, n: sql<number>`count(*)::int` })
        .from(payments)
        .where(eq(payments.estado, 'pendiente'));
      return { mes, ingresosConfirmados: Number(ingresos?.total ?? 0), pagosConfirmados: ingresos?.n ?? 0, totalPendiente: Number(pendientes?.total ?? 0), pagosPendientes: pendientes?.n ?? 0 };
    }
    case 'preparar_notificacion': {
      if (!isAdmin) return 'No autorizado.';
      const titulo = String(args.titulo ?? '').trim();
      const mensaje = String(args.mensaje ?? '').trim();
      if (!titulo || !mensaje) return 'Faltan el título o el mensaje de la notificación.';
      const dest = await resolveDestinatarios(args);
      if (dest.error) return dest.error;
      if (dest.rows.length === 0) return 'No hay destinatarios que coincidan; revisa la audiencia.';
      return {
        estado: 'BORRADOR — todavía NO enviado',
        titulo,
        mensaje,
        audiencia: dest.audiencia === 'todos' ? 'Todos los miembros activos' : 'Usuarios seleccionados',
        totalDestinatarios: dest.rows.length,
        nombres: dest.audiencia === 'usuarios' ? dest.rows.map((r) => r.nombre) : undefined,
        instruccion: 'Muéstrale al admin este borrador (título, el texto EXACTO del mensaje y a cuántos/quiénes llega) y pregúntale si desea enviarlo. NO llames enviar_notificacion en este mismo turno: espera la confirmación del admin.',
      };
    }
    case 'enviar_notificacion': {
      if (!isAdmin) return 'No autorizado.';
      const titulo = String(args.titulo ?? '').trim();
      const mensaje = String(args.mensaje ?? '').trim();
      if (!titulo || !mensaje) return 'Faltan el título o el mensaje de la notificación.';
      const dest = await resolveDestinatarios(args);
      if (dest.error) return dest.error;
      if (dest.rows.length === 0) return 'No hay destinatarios que coincidan; no se envió nada.';
      for (const r of dest.rows) {
        await notifyUser(r.id, { title: titulo, body: mensaje, url: '/app' }, { tipo: 'sistema' }).catch(() => {});
      }
      return `Notificación enviada a ${dest.rows.length} miembro(s).`;
    }
    case 'buscar_usuario': {
      if (!isAdmin) return 'No autorizado.';
      const q = String(args.nombre ?? '').trim();
      if (!q) return 'Falta el nombre a buscar.';
      const rows = await db
        .select({ id: users.id, nombre: users.nombreCompleto, rol: users.rol })
        .from(users)
        .where(and(eq(users.activo, true), ilike(users.nombreCompleto, `%${q}%`)))
        .limit(15);
      return rows.length ? rows : `No encontré usuarios que coincidan con "${q}".`;
    }
    case 'detalle_usuario': {
      if (!isAdmin) return 'No autorizado.';
      const id = String(args.id ?? '');
      const planes = await db
        .select({ plan: planTypes.nombre, fechaInicio: userPlans.fechaInicio, fechaFin: userPlans.fechaFin })
        .from(userPlans).innerJoin(planTypes, eq(userPlans.planTypeId, planTypes.id))
        .where(and(eq(userPlans.userId, id), eq(userPlans.estado, 'activo')));
      const proximas = await db
        .select({ clase: classTemplates.nombre, fecha: classSessions.fecha, hora: classTemplates.horaInicio })
        .from(bookings).innerJoin(classSessions, eq(bookings.sessionId, classSessions.id)).innerJoin(classTemplates, eq(classSessions.templateId, classTemplates.id))
        .where(and(eq(bookings.userId, id), eq(bookings.estado, 'activa'), gte(classSessions.fecha, todayStr())))
        .orderBy(classSessions.fecha).limit(10);
      const pagos = await db
        .select({ monto: payments.montoCop, estado: payments.estado, metodo: payments.metodo, fecha: payments.createdAt })
        .from(payments).where(eq(payments.userId, id)).orderBy(desc(payments.createdAt)).limit(5);
      const s = await computeUserScoring(id);
      return { planes, proximasReservas: proximas, ultimosPagos: pagos, scoring: { porcentajeMes: s.porcentaje, rachaActual: s.rachaActual, nivel: s.nivel } };
    }
    case 'usuarios_inactivos': {
      if (!isAdmin) return 'No autorizado.';
      const dias = Number(args.dias) > 0 ? Number(args.dias) : 30;
      const desde = format(addDays(toZonedTime(new Date(), TZ), -dias), 'yyyy-MM-dd');
      const miembros = await db.select({ id: users.id, nombre: users.nombreCompleto }).from(users).where(and(eq(users.rol, 'user'), eq(users.activo, true)));
      const result: { nombre: string; ultimaAsistencia: string }[] = [];
      for (const m of miembros) {
        const [last] = await db
          .select({ fecha: classSessions.fecha })
          .from(bookings).innerJoin(classSessions, eq(bookings.sessionId, classSessions.id))
          .where(and(eq(bookings.userId, m.id), eq(bookings.estado, 'asistio')))
          .orderBy(desc(classSessions.fecha)).limit(1);
        if (!last || last.fecha < desde) result.push({ nombre: m.nombre, ultimaAsistencia: last?.fecha ?? 'nunca' });
      }
      return result.length ? result : `Todos los miembros han asistido en los últimos ${dias} días.`;
    }
    default:
      return 'Tool desconocida.';
  }
}

// Políticas reales del club (derivadas de la lógica de reservas). El agente las usa
// para responder sobre el funcionamiento; NUNCA debe decir que no las conoce.
const FITVANG_RULES = `REGLAS Y POLÍTICAS DE FITVANG (úsalas para responder cómo funciona el club):
- Anticipación: las reservas se hacen con AL MENOS 30 minutos de antelación; no se puede reservar una clase que ya empezó.
- Modificar/cancelar una reserva: con AL MENOS 1 hora de antelación; más tarde ya no se puede.
- Horario para reservar: no se reserva entre las 11 PM y las 6 AM.
- Plan activo: solo con plan activo se reserva, y el plan debe cubrir ese tipo de clase. Algunas clases están restringidas a ciertos planes.
- Cupos: cada clase tiene cupos limitados; si está llena, el usuario entra a LISTA DE ESPERA y se le avisa si se libera un lugar.
- Clases Kids: la inscripción la hace el administrador, no el propio usuario.
- Cada reserva consume una sesión del plan (si el plan tiene cupo de sesiones).`;

// ── Prompt de sistema según rol ─────────────────────────────────────────────
function systemPrompt(u: AgentUser, contexto: string): string {
  const base = `Eres Vang, el asistente con IA de Fitvang — club de entrenamiento funcional y fútbol funcional en Cali, Colombia (fitvang.com). Hoy es ${todayStr()} (America/Bogota).

PERSONALIDAD: relajado, cercano y motivador, como un parcero del gym que sabe del tema. Tono casual colombiano (puedes decir "parce", "listo", "de una", "tranqui") pero sin exagerar ni sonar forzado, y siempre respetuoso. Directo y sin rodeos, respuestas cortas (máx 3 párrafos). Puedes usar **negritas**, viñetas y algún emoji ocasional para que se sienta natural. Responde SIEMPRE en español.

QUÉ HACES: das tips de ejercicio y técnica, alimentación, recomendaciones pre y post entreno, motivación e info del club; y consultas datos REALES con tus herramientas.

REGLA DE ORO — DATOS: NUNCA inventes, estimes ni completes datos. Para planes, reservas, pagos, clases o asistencia DEBES llamar la herramienta correcta ANTES de responder, y responder SOLO con lo que devolvió. Si una herramienta viene vacía, dilo tal cual ("no encontré...", "no tienes..."). Nunca rellenes huecos con datos inventados.`;

  if (u.rol !== 'super_admin') {
    return `${base}

USUARIO: ${u.nombre}.
PRIVACIDAD ESTRICTA E INNEGOCIABLE: solo puedes dar información de ESTE usuario. Tus herramientas ya están limitadas a sus datos; no existe forma de ver datos de otras personas ni estadísticas globales del club. No envíes notificaciones ni hagas acciones administrativas.
${contexto}

${FITVANG_RULES}`;
  }
  return `${base}

ADMINISTRADOR: ${u.nombre}. Tienes acceso a toda la data del club.
- Para preguntas sobre un usuario por nombre/apodo: usa SIEMPRE buscar_usuario primero (búsqueda parcial) y luego detalle_usuario con el id que devuelva, antes de responder.
- Puedes responder quién está reservado en una fecha/hora (con nombres completos), quién pagó o debe, resúmenes financieros y quién lleva días sin reservar.
- Lista los nombres completos individualmente, no solo conteos.

ENVÍO DE NOTIFICACIONES — protocolo OBLIGATORIO, síguelo paso a paso y NUNCA lo saltes:
1. Cuando el admin quiera enviar una notificación, primero REÚNE lo necesario preguntando lo que falte: el TÍTULO, el MENSAJE y a QUIÉN va dirigida (a todos los miembros activos, o a usuarios específicos). Nunca asumas la audiencia ni el contenido: si no te lo dieron, pregúntalo. Para usuarios específicos, usa buscar_usuario para obtener sus IDs.
2. Cuando tengas título, mensaje y audiencia, llama a preparar_notificacion (esto NO envía). Luego muéstrale al admin el BORRADOR completo: el título, el texto EXACTO del mensaje y a cuántos/quiénes llegaría. Termina SIEMPRE preguntándole si desea enviarla.
3. NO envíes en ese mismo turno. Detente y espera la respuesta del admin.
4. Solo si el admin CONFIRMA explícitamente el envío (ej. "sí, envíala"), llama a enviar_notificacion con el mismo título, mensaje y audiencia del borrador. Si pide cambios, ajústalos y vuelve a mostrar el borrador (paso 2).
5. Regla absoluta: jamás llames enviar_notificacion sin haber mostrado antes el borrador y recibido una confirmación explícita del admin.

${FITVANG_RULES}`;
}

// ── Llamada al LLM (Groq → DeepSeek) ────────────────────────────────────────
async function callLLM(messages: ChatMessage[], tools: any[]): Promise<ChatMessage> {
  const providers = [
    { url: 'https://api.groq.com/openai/v1/chat/completions', key: env.GROQ_API_KEY, model: 'llama-3.3-70b-versatile' },
    { url: 'https://api.deepseek.com/chat/completions', key: env.DEEPSEEK_API_KEY, model: 'deepseek-chat' },
  ].filter((p) => p.key);
  if (providers.length === 0) throw new Error('ia_no_configurada');

  let lastErr = '';
  for (const p of providers) {
    try {
      const res = await fetch(p.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.key}` },
        body: JSON.stringify({ model: p.model, messages, tools, tool_choice: 'auto', temperature: 0.3, max_tokens: 1000 }),
      });
      if (!res.ok) { lastErr = `${p.model}: ${res.status} ${await res.text().catch(() => '')}`.slice(0, 300); continue; }
      const data = await res.json();
      const msg = data?.choices?.[0]?.message;
      if (msg) return msg as ChatMessage;
    } catch (e) {
      lastErr = `${p.model}: ${String(e)}`;
    }
  }
  throw new Error('llm_failed: ' + lastErr);
}

// ── Análisis financiero (sin tools, una sola llamada) ───────────────────────
export async function analyzeFinances(meses: unknown): Promise<string> {
  const sys: ChatMessage = {
    role: 'system',
    content: `Eres Vang, el analista de Fitvang. Te paso datos financieros mensuales en COP. Responde en español, relajado pero profesional. Da: 3-4 **conclusiones** en viñetas (tendencia de ingresos, total por cobrar/pendientes, mejor y peor mes) y 1 **recomendación** accionable al final. Usa negritas y viñetas. Sé concreto y NO inventes: básate solo en los números que te paso.`,
  };
  const user: ChatMessage = { role: 'user', content: `Datos por mes (más reciente primero): ${JSON.stringify(meses)}` };
  try {
    const msg = await callLLM([sys, user], []);
    return msg.content ?? 'No pude generar el análisis.';
  } catch {
    return 'No pude generar el análisis en este momento.';
  }
}

// ── Loop principal con tool-calling ─────────────────────────────────────────
export async function runAgent(
  u: AgentUser,
  history: ChatMessage[],
  onTool?: (name: string) => void | Promise<void>,
): Promise<string> {
  const tools = u.rol === 'super_admin' ? [...USER_TOOLS, ...ADMIN_TOOLS] : USER_TOOLS;

  // Contexto inmediato del usuario (no-admin): plan(es) y próxima clase, para que
  // responda con naturalidad sin gastar una herramienta en lo básico.
  let contexto = '';
  if (u.rol !== 'super_admin') {
    try {
      const planes = await db
        .select({ plan: planTypes.nombre, fechaFin: userPlans.fechaFin })
        .from(userPlans).innerJoin(planTypes, eq(userPlans.planTypeId, planTypes.id))
        .where(and(eq(userPlans.userId, u.sub), eq(userPlans.estado, 'activo')));
      const [prox] = await db
        .select({ clase: classTemplates.nombre, fecha: classSessions.fecha, hora: classTemplates.horaInicio })
        .from(bookings).innerJoin(classSessions, eq(bookings.sessionId, classSessions.id)).innerJoin(classTemplates, eq(classSessions.templateId, classTemplates.id))
        .where(and(eq(bookings.userId, u.sub), eq(bookings.estado, 'activa'), gte(classSessions.fecha, todayStr())))
        .orderBy(classSessions.fecha, classTemplates.horaInicio).limit(1);
      const planTxt = planes.length ? planes.map((p) => `${p.plan} (vence ${p.fechaFin})`).join(', ') : 'sin plan activo';
      const proxTxt = prox ? `${prox.clase} el ${prox.fecha} a las ${prox.hora.slice(0, 5)}` : 'sin reservas próximas';
      contexto = `CONTEXTO ACTUAL: Plan(es): ${planTxt}. Próxima clase: ${proxTxt}.`;
    } catch { /* contexto best-effort */ }
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt(u, contexto) },
    ...history.slice(-12), // contexto acotado
  ];

  for (let i = 0; i < 8; i++) {
    const msg = await callLLM(messages, tools);
    messages.push(msg);
    const calls = msg.tool_calls ?? [];
    if (calls.length === 0) return msg.content ?? '';

    for (const call of calls) {
      let args: any = {};
      try { args = JSON.parse(call.function?.arguments || '{}'); } catch { args = {}; }
      await onTool?.(call.function?.name);
      let result: unknown;
      if (call.function?.name === 'enviar_notificacion' && !borradorYaConfirmado(history, args)) {
        // El admin aún no confirmó el borrador en un turno previo → no enviar.
        result = 'No se envió nada. Antes de enviar debes preparar el borrador con preparar_notificacion, mostrárselo al admin y esperar a que confirme el envío en su siguiente mensaje. Muéstrale el borrador ahora y pregúntale si desea enviarlo.';
      } else {
        try { result = await execTool(call.function?.name, args, u); }
        catch (e) { result = `Error ejecutando la herramienta: ${String(e)}`; }
      }
      messages.push({ role: 'tool', tool_call_id: call.id, name: call.function?.name, content: typeof result === 'string' ? result : JSON.stringify(result) });
    }
  }
  // Si se agotaron las iteraciones, una última respuesta sin tools
  const final = await callLLM(messages, []);
  return final.content ?? 'No pude completar la respuesta.';
}

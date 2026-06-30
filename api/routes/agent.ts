import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requireAuth } from '../middleware/jwt';
import { runAgent, type AgentUser } from '../services/agent.service';

export const agentRouter = new Hono();
agentRouter.use('*', requireAuth);

const chatSchema = z.object({
  messages: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(4000) }))
    .min(1)
    .max(30),
});

agentRouter.post('/chat', zValidator('json', chatSchema), async (c) => {
  const me = c.get('user');
  const { messages } = c.req.valid('json');
  const u: AgentUser = { sub: me.sub, rol: me.rol, nombre: me.nombre };
  try {
    const reply = await runAgent(u, messages as any);
    return c.json({ reply });
  } catch (e) {
    console.error('[agent] error', e);
    const m = String(e).includes('ia_no_configurada')
      ? 'El asistente no está configurado.'
      : 'No pude responder en este momento. Intenta de nuevo.';
    return c.json({ error: 'agent_error', message: m }, 500);
  }
});

// Variante SSE: emite eventos 'tool' (cada vez que consulta datos) y 'done' (respuesta).
agentRouter.post('/stream', zValidator('json', chatSchema), (c) => {
  const me = c.get('user');
  const { messages } = c.req.valid('json');
  const u: AgentUser = { sub: me.sub, rol: me.rol, nombre: me.nombre };
  return streamSSE(c, async (stream) => {
    try {
      const reply = await runAgent(u, messages as any, async (name) => {
        await stream.writeSSE({ event: 'tool', data: name });
      });
      await stream.writeSSE({ event: 'done', data: JSON.stringify({ reply }) });
    } catch (e) {
      console.error('[agent] stream error', e);
      await stream.writeSSE({ event: 'error', data: 'No pude responder en este momento.' });
    }
  });
});

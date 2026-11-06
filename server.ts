import express from 'express';
import { z } from 'zod';
import { prisma } from './db';
import type { Prisma } from './generated/prisma/client.js';

type Status = 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'ABANDONED';

// Schemas: one source of truth for validation and TypeScript types
const actionSchema = z.enum(['pause', 'resume', 'complete', 'abandon']);
type Action = z.infer<typeof actionSchema>;

const MAX_PLANNED_SECONDS = 4 * 60 * 60;


const createSessionSchema = z.object({
  task: z.string().trim().min(1, 'task is required').max(200),
  firstStep: z.string().trim().min(1).max(200).optional(),
  plannedSeconds: z.number().int().min(60).max(4 * 60 * 60).default(900),
});

const extendSchema = z.object({
  seconds: z.number().int().min(60).max(3600).default(300),
});

const actionBodySchema = z.object({
    note: z.string().trim().min(1).max(500).optional(),

})
const distractionSchema = z.object({
  note: z.string().trim().min(1, 'note is required').max(500),
});

// State machine: from-status -> action -> to-status
const transitions: Record<Status, Partial<Record<Action, Status>>> = {
  ACTIVE: { pause: 'PAUSED', complete: 'COMPLETED', abandon: 'ABANDONED' },
  PAUSED: { resume: 'ACTIVE', abandon: 'ABANDONED' },
  COMPLETED: {},
  ABANDONED: {},
};

const withDistractions = { distractions: true } as const;
type SessionWithDistractions = Prisma.SessionGetPayload<{
  include: typeof withDistractions;
}>;

const OPEN: Status[] = ['ACTIVE', 'PAUSED'];

const current = () =>
  prisma.session.findFirst({
    where: { status: { in: OPEN } },
    include: withDistractions,
  });

// Never store elapsed time; derive it
function elapsedMs(s: SessionWithDistractions, now = Date.now()) {
  const end = s.endedAt?.getTime() ?? s.pausedAt?.getTime() ?? now;
  return end - s.startedAt.getTime() - s.pausedTotalMs;
}

const view = (s: SessionWithDistractions) => {
  const elapsed = Math.floor(elapsedMs(s) / 1000);
  return {
    ...s,
    elapsedSeconds: elapsed,
    remainingSeconds: Math.max(0, s.plannedSeconds - elapsed),
  };
};

// Returns parsed data, or sends a 400 and returns null
function parseBody<T extends z.ZodTypeAny>(
  schema: T,
  body: unknown,
  res: express.Response,
): z.infer<T> | null {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    res.status(400).json({
      error: 'validation_failed',
      details: result.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    });
    return null;
  }
  return result.data;
}

const isUniqueViolation = (e: unknown) =>
  typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';

export const app = express();
app.use(express.json());

app.post('/sessions', async (req, res) => {
  const data = parseBody(createSessionSchema, req.body, res);
  if (!data) return;

  if (await current()) {
    return res.status(409).json({ error: 'finish or abandon your current session first' });
  }

  try {
    const s = await prisma.session.create({
      data: { task: data.task, firstStep: data.firstStep, plannedSeconds: data.plannedSeconds },
      include: withDistractions,
    });
    res.status(201).json(view(s));
  } catch (e) {
    // Two requests raced past the check above: the database index is the backstop
    if (isUniqueViolation(e)) {
      return res.status(409).json({ error: 'finish or abandon your current session first' });
    }
    throw e;
  }
});

app.get('/sessions/current', async (_req, res) => {
  const s = await current();
  if (!s) return res.status(404).json({ error: 'no active session' });
  res.json(view(s));
});

// The parking lot: dump a thought without leaving the task.
// Must be registered BEFORE the generic /:action route below.
app.post('/sessions/:id/distractions', async (req, res) => {
  const s = await prisma.session.findUnique({ where: { id: req.params.id } });
  if (!s || !OPEN.includes(s.status)) {
    return res.status(404).json({ error: 'no open session' });
  }
  const data = parseBody(distractionSchema, req.body, res);
  if (!data) return;

  const updated = await prisma.session.update({
    where: { id: s.id },
    data: { distractions: { create: { note: data.note } } },
    include: withDistractions,
  });
  res.status(201).json(view(updated));
});



app.post('/sessions/:id/extend', async (req, res) => {
  const data = parseBody(extendSchema, req.body, res);
  if (!data) return;

  const s = await prisma.session.findUnique({
    where: { id: req.params.id },
    include: withDistractions,
  });
  if (!s) return res.status(404).json({ error: 'not found' });
  if (!OPEN.includes(s.status)) {
    return res.status(409).json({ error: `cannot extend a ${s.status} session` });
  }

  // "N more minutes" counts from now, even if the timer already ran out
  const elapsed = Math.floor(elapsedMs(s) / 1000);
  const newPlanned = Math.max(s.plannedSeconds, elapsed) + data.seconds;
  if (newPlanned > MAX_PLANNED_SECONDS) {
    return res.status(409).json({ error: 'session length limit reached, take a break' });
  }

  // Optimistic concurrency, same pattern as the state transitions
  const { count } = await prisma.session.updateMany({
    where: { id: s.id, status: s.status, plannedSeconds: s.plannedSeconds },
    data: { plannedSeconds: newPlanned },
  });
  if (count === 0) {
    return res.status(409).json({ error: 'session changed, please retry' });
  }

  const updated = await prisma.session.findUniqueOrThrow({
    where: { id: s.id },
    include: withDistractions,
  });
  res.json(view(updated));
});






app.post('/sessions/:id/:action', async (req, res) => {
  const parsed = actionSchema.safeParse(req.params.action);
  if (!parsed.success) {
    return res.status(400).json({ error: `unknown action: ${req.params.action}` });
  }
  const action = parsed.data;
  const body = parseBody(actionBodySchema, req.body, res);
  if (!body) return;
  
  const s = await prisma.session.findUnique({ where: { id: req.params.id } });
  if (!s) return res.status(404).json({ error: 'not found' });

  const next = transitions[s.status][action];
  if (!next) {
    return res.status(409).json({ error: `cannot ${action} a ${s.status} session` });
  }

  const now = new Date();
  const data: Prisma.SessionUpdateManyMutationInput = { status: next };
  if (action === 'pause') data.pausedAt = now;
  if (action === 'resume' && s.pausedAt) {
    data.pausedTotalMs = s.pausedTotalMs + (now.getTime() - s.pausedAt.getTime());
    data.pausedAt = null;
  }
  if (action === 'complete' || action === 'abandon') {
    // If abandoned while paused, time stops counting at the moment of the pause
    data.endedAt = s.pausedAt ?? now;
  }
  if ((action === 'pause' || action === 'abandon') && body.note) {
  data.leftOffNote = body.note;
  }

  // Optimistic concurrency: only update if the status is still what we read
  const { count } = await prisma.session.updateMany({
    where: { id: s.id, status: s.status },
    data,
  });
  if (count === 0) {
    return res.status(409).json({ error: 'session changed, please retry' });
  }

  const updated = await prisma.session.findUniqueOrThrow({
    where: { id: s.id },
    include: withDistractions,
  });
  res.json(view(updated));
});


// Error handler (Express 5 forwards rejected async handlers here)
app.use(
  (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if ((err as { type?: string })?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'invalid JSON body' });
    }
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  },
);
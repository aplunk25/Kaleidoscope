import express from 'express';
import { randomUUID } from 'crypto';
import { z } from 'zod';

type Status = 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'ABANDONED';

// Schemas: one source of truth for validation and TypeScript types
const actionSchema = z.enum(['pause', 'resume', 'complete', 'abandon']);
type Action = z.infer<typeof actionSchema>;

const createSessionSchema = z.object({
  task: z.string().trim().min(1, 'task is required').max(200),
  plannedSeconds: z.number().int().min(60).max(4 * 60 * 60).default(900),
});

const distractionSchema = z.object({
  note: z.string().trim().min(1, 'note is required').max(500),
});

interface Session {
  id: string;
  task: string;
  plannedSeconds: number;
  status: Status;
  startedAt: number;
  pausedAt: number | null;
  pausedTotalMs: number;
  endedAt: number | null;
  distractions: { note: string; at: number }[];
}

// State machine: from-status -> action -> to-status
const transitions: Record<Status, Partial<Record<Action, Status>>> = {
  ACTIVE: { pause: 'PAUSED', complete: 'COMPLETED', abandon: 'ABANDONED' },
  PAUSED: { resume: 'ACTIVE', abandon: 'ABANDONED' },
  COMPLETED: {},
  ABANDONED: {},
};

export const sessions = new Map<string, Session>();

const isOpen = (s: Session) => s.status === 'ACTIVE' || s.status === 'PAUSED';
const current = () => [...sessions.values()].find(isOpen);

// Never store elapsed time; derive it
function elapsedMs(s: Session, now = Date.now()) {
  const end = s.endedAt ?? s.pausedAt ?? now;
  return end - s.startedAt - s.pausedTotalMs;
}

const view = (s: Session) => ({
  ...s,
  elapsedSeconds: Math.floor(elapsedMs(s) / 1000),
  remainingSeconds: Math.max(0, s.plannedSeconds - Math.floor(elapsedMs(s) / 1000)),
});

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

export const app = express();
app.use(express.json());

app.post('/sessions', (req, res) => {
  const data = parseBody(createSessionSchema, req.body, res);
  if (!data) return;
  if (current()) {
    return res.status(409).json({ error: 'finish or abandon your current session first' });
  }
  const s: Session = {
    id: randomUUID(),
    task: data.task,
    plannedSeconds: data.plannedSeconds,
    status: 'ACTIVE',
    startedAt: Date.now(),
    pausedAt: null,
    pausedTotalMs: 0,
    endedAt: null,
    distractions: [],
  };
  sessions.set(s.id, s);
  res.status(201).json(view(s));
});

app.get('/sessions/current', (_req, res) => {
  const s = current();
  s ? res.json(view(s)) : res.status(404).json({ error: 'no active session' });
});

// The parking lot: dump a thought without leaving the task.
// Must be registered BEFORE the generic /:action route below.
app.post('/sessions/:id/distractions', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s || !isOpen(s)) return res.status(404).json({ error: 'no open session' });
  const data = parseBody(distractionSchema, req.body, res);
  if (!data) return;
  s.distractions.push({ note: data.note, at: Date.now() });
  res.status(201).json(view(s));
});

app.post('/sessions/:id/:action', (req, res) => {
  const parsed = actionSchema.safeParse(req.params.action);
  if (!parsed.success) {
    return res.status(400).json({ error: `unknown action: ${req.params.action}` });
  }
  const action = parsed.data;

  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });

  const next = transitions[s.status][action];
  if (!next) {
    return res.status(409).json({ error: `cannot ${action} a ${s.status} session` });
  }

  const now = Date.now();
  if (action === 'pause') s.pausedAt = now;
  if (action === 'resume' && s.pausedAt) {
    s.pausedTotalMs += now - s.pausedAt;
    s.pausedAt = null;
  }
  if (action === 'complete' || action === 'abandon') s.endedAt = now;

  s.status = next;
  res.json(view(s));
});
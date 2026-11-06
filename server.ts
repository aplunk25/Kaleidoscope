import express from 'express';
import { randomUUID } from 'crypto';

type Status = 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'ABANDONED';
type Action = 'pause' | 'resume' | 'complete' | 'abandon';

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

const sessions = new Map<string, Session>();

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

const app = express();
app.use(express.json());

app.post('/sessions', (req, res) => {
  const { task, plannedSeconds = 900 } = req.body ?? {};
  if (typeof task !== 'string' || !task.trim()) {
    return res.status(400).json({ error: 'task is required' });
  }
  if (current()) {
    return res.status(409).json({ error: 'finish or abandon your current session first' });
  }
  const s: Session = {
    id: randomUUID(),
    task: task.trim(),
    plannedSeconds,
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

app.post('/sessions/:id/:action', (req, res) => {
  const s = sessions.get(req.params.id);
  const action = req.params.action as Action;
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

// The parking lot: dump a thought without leaving the task
app.post('/sessions/:id/distractions', (req, res) => {
  const s = sessions.get(req.params.id);
  const { note } = req.body ?? {};
  if (!s || !isOpen(s)) return res.status(404).json({ error: 'no open session' });
  if (typeof note !== 'string' || !note.trim()) {
    return res.status(400).json({ error: 'note is required' });
  }
  s.distractions.push({ note: note.trim(), at: Date.now() });
  res.status(201).json(view(s));
});

app.listen(3000, () => console.log('http://localhost:3000'));
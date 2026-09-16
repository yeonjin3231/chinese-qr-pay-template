import { getStore } from '@netlify/blobs';

const KEY = 'state';
// Each deployment can set its own admin PIN via a TEACHER_PIN environment
// variable (Netlify site settings → Environment variables) without touching
// code — this matters once the same codebase is deployed by many teachers.
const TEACHER_PIN = process.env.TEACHER_PIN || '2026';

// No roster is baked into the code — the teacher populates it by uploading
// an Excel/CSV export from the teacher dashboard (see the 'importRoster' action).
function initialState() {
  return { students: [], transactions: [] };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

// The raw `pin` must never leave the server: this endpoint has no auth on GET
// (students need to load the roster before they've logged in), so anyone with
// the URL could otherwise read every student's PIN. Only `pinSet` (used to
// decide whether a student is doing first-time setup) is sent to clients.
function redact(state) {
  return {
    ...state,
    students: state.students.map(({ pin, ...rest }) => rest)
  };
}

function getStateStore() {
  return getStore({ name: 'ketang-pay', consistency: 'strong' });
}

// Reads the current state, applies `mutate` to a deep copy, and writes it back.
// `mutate` returns either { state } to persist, or { error } to abort without writing.
// Retries on write conflicts from concurrent requests (optimistic concurrency via ETag).
async function updateState(store, mutate) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const entry = await store.getWithMetadata(KEY, { type: 'json', consistency: 'strong' });
    const current = entry?.data ?? initialState();
    const result = mutate(structuredClone(current));
    if (result.error) return result;

    const writeOptions = entry?.etag ? { onlyIfMatch: entry.etag } : { onlyIfNew: true };
    const written = await store.setJSON(KEY, result.state, writeOptions);
    if (written.modified) return { state: result.state };
    // Someone else wrote in between — retry with fresh data.
  }
  return { error: 'busy, try again' };
}

function findStudent(state, id) {
  return state.students.find((s) => s.id === id);
}

export default async (request) => {
  const store = getStateStore();

  if (request.method === 'GET') {
    let data = await store.get(KEY, { type: 'json', consistency: 'strong' });
    if (!data) {
      data = initialState();
      await store.setJSON(KEY, data, { onlyIfNew: true });
    }
    return json(redact(data));
  }

  if (request.method !== 'POST') {
    return json({ error: 'method not allowed' }, 405);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid json' }, 400);
  }

  const requiresTeacher = new Set([
    'updateDojo', 'resetPin', 'deleteStudent', 'addStudent', 'importRoster', 'refund', 'clearTransactions', 'resetDemo', 'revealPin'
  ]);
  if (requiresTeacher.has(body.action) && body.teacherPin !== TEACHER_PIN) {
    return json({ error: 'unauthorized' }, 401);
  }

  if (body.action === 'revealPin') {
    const current = await store.get(KEY, { type: 'json', consistency: 'strong' }) ?? initialState();
    const student = findStudent(current, body.studentId);
    if (!student) return json({ error: 'student not found' }, 404);
    return json({ pin: student.pin });
  }

  let outcome;
  switch (body.action) {
    case 'login': {
      const { studentId, pin } = body;
      outcome = await updateState(store, (state) => {
        const student = findStudent(state, studentId);
        if (!student) return { error: 'student not found' };
        if (!/^\d{4}$/.test(pin || '')) return { error: 'invalid pin format' };
        if (!student.pinSet) {
          student.pin = pin;
          student.pinSet = true;
        } else if (student.pin !== pin) {
          return { error: 'wrong pin' };
        }
        return { state };
      });
      break;
    }
    case 'pay': {
      const { studentId, amount } = body;
      const amt = Math.floor(Number(amount));
      outcome = await updateState(store, (state) => {
        const student = findStudent(state, studentId);
        if (!student) return { error: 'student not found' };
        if (!Number.isFinite(amt) || amt <= 0) return { error: 'invalid amount' };
        if (amt > student.balance) return { error: 'insufficient balance' };
        student.balance -= amt;
        state.transactions.push({
          id: crypto.randomUUID(),
          studentId: student.id,
          studentName: student.name,
          amount: amt,
          createdAt: new Date().toISOString()
        });
        return { state };
      });
      break;
    }
    case 'updateDojo': {
      const { studentId, dojo } = body;
      const d = Math.max(0, Math.floor(Number(dojo) || 0));
      outcome = await updateState(store, (state) => {
        const student = findStudent(state, studentId);
        if (!student) return { error: 'student not found' };
        student.dojo = d;
        student.balance = d * 2;
        return { state };
      });
      break;
    }
    case 'resetPin': {
      const { studentId } = body;
      outcome = await updateState(store, (state) => {
        const student = findStudent(state, studentId);
        if (!student) return { error: 'student not found' };
        student.pin = null;
        student.pinSet = false;
        return { state };
      });
      break;
    }
    case 'deleteStudent': {
      const { studentId } = body;
      outcome = await updateState(store, (state) => {
        state.students = state.students.filter((s) => s.id !== studentId);
        return { state };
      });
      break;
    }
    case 'addStudent': {
      const { name, pack, dojo } = body;
      const trimmed = (name || '').trim();
      if (!trimmed) return json({ error: 'name required' }, 400);
      const d = Math.max(0, Math.floor(Number(dojo) || 0));
      outcome = await updateState(store, (state) => {
        state.students.push({
          id: crypto.randomUUID(),
          name: trimmed,
          pack: pack || '1',
          dojo: d,
          balance: d * 2,
          pin: null,
          pinSet: false
        });
        return { state };
      });
      break;
    }
    case 'importRoster': {
      const { pack: defaultPack, students: rows } = body;
      if (!Array.isArray(rows) || !rows.length) return json({ error: 'no rows' }, 400);
      const fresh = rows.map((r) => {
        const name = String(r.name || '').trim();
        const pack = String(r.pack || defaultPack || '1');
        const dojo = Math.max(0, Math.floor(Number(r.dojo) || 0));
        return name ? { id: crypto.randomUUID(), name, pack, dojo, balance: dojo * 2, pin: null, pinSet: false } : null;
      }).filter(Boolean);
      if (!fresh.length) return json({ error: 'no valid rows' }, 400);
      outcome = await updateState(store, (state) => {
        // Replace the roster only for packs present in this upload; other packs are untouched.
        const touchedPacks = new Set(fresh.map((s) => s.pack));
        state.students = [...state.students.filter((s) => !touchedPacks.has(s.pack)), ...fresh];
        return { state };
      });
      break;
    }
    case 'refund': {
      const { transactionId } = body;
      outcome = await updateState(store, (state) => {
        const tx = state.transactions.find((t) => t.id === transactionId);
        if (!tx) return { state };
        const student = findStudent(state, tx.studentId);
        if (student) student.balance += tx.amount;
        state.transactions = state.transactions.filter((t) => t.id !== transactionId);
        return { state };
      });
      break;
    }
    case 'clearTransactions': {
      outcome = await updateState(store, (state) => {
        state.transactions = [];
        return { state };
      });
      break;
    }
    case 'resetDemo': {
      const fresh = initialState();
      await store.setJSON(KEY, fresh);
      outcome = { state: fresh };
      break;
    }
    case 'verifyTeacherPin': {
      return json({ ok: true });
    }
    default:
      return json({ error: 'unknown action' }, 400);
  }

  if (outcome.error) return json({ error: outcome.error }, 400);
  return json(redact(outcome.state));
};

export const config = { path: '/api/state' };

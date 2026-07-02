/**
 * Prueba de integración del servicio battlecaos-room.
 * Actúa como "gateway falso": publica mensajes en svc:room y escucha
 * las respuestas en gw:broadcast + evt:* para verificar el flujo real.
 *
 * Requisito: el servicio room debe estar corriendo (npm run dev).
 * Uso: node scripts/test-integracion.js
 */
import 'dotenv/config';
import Redis from 'ioredis';

// IDs únicos por ejecución — evita colisiones con datos de runs anteriores en Redis
const RUN      = Date.now().toString(36);
const SOCKET_A = `test-sA-${RUN}`;
const SOCKET_B = `test-sB-${RUN}`;
const SOCKET_C = `test-sC-${RUN}`;
const SOCKET_D = `test-sD-${RUN}`;
const PLAYER_A = `player-A-${RUN}`;
const PLAYER_B = `player-B-${RUN}`;

const opts = { lazyConnect: true, maxRetriesPerRequest: 3 };
const pub  = new Redis(process.env.REDIS_URL, opts);
const sub  = new Redis(process.env.REDIS_URL, opts);

await pub.connect();
await sub.connect();

await sub.subscribe(
  'gw:broadcast',
  'evt:PlayerRoomJoined',
  'evt:RoomReady',
  'evt:PlayerDisconnectedFromRoom',
  'evt:RoomDestroyed',
);

// ── Colector de mensajes ──────────────────────────────────────────────────────

const msgs = [];
sub.on('message', (channel, raw) => {
  msgs.push({ channel, ...JSON.parse(raw) });
});

function waitFor(predicate, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout;
    const tick = setInterval(() => {
      const found = msgs.find(predicate);
      if (found)               { clearInterval(tick); resolve(found); }
      else if (Date.now() > deadline) { clearInterval(tick); reject(new Error('timeout — no llegó el mensaje esperado')); }
    }, 50);
  });
}

// ── Utilidades de reporte ─────────────────────────────────────────────────────

let passed = 0, failed = 0;

async function check(label, fn) {
  try {
    await fn();
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
    passed++;
  } catch (err) {
    console.log(`  \x1b[31m✗\x1b[0m ${label}`);
    console.log(`    \x1b[90m→ ${err.message}\x1b[0m`);
    failed++;
  }
}

function send(type, data) {
  return pub.publish('svc:room', JSON.stringify({
    type, source: 'gateway', timestamp: Date.now(), data,
  }));
}

// ── TEST 1: Crear sala 1v1 ────────────────────────────────────────────────────

console.log('\n\x1b[1m[1] room:create — modo 1v1\x1b[0m');

await send('room:create', {
  socketId: SOCKET_A,
  modo:     '1v1',
  playerId: PLAYER_A,
  name:     'Jugador A',
});

let codigo;

await check('room service responde con room:created (tiene código 6 dígitos)', async () => {
  const m = await waitFor(m =>
    m.channel === 'gw:broadcast' && m.event === 'room:created' && m.roomId === SOCKET_A
  );
  codigo = m.payload.codigo;
  if (!codigo || !/^\d{6}$/.test(codigo)) throw new Error(`código inválido: "${codigo}"`);
  console.log(`    \x1b[90m→ sala: ${codigo}\x1b[0m`);
});

await check('room service pide al gateway unir el socket a la sala (room:join-socket-room)', async () => {
  const m = await waitFor(m =>
    m.channel === 'gw:broadcast' && m.event === 'room:join-socket-room' && m.roomId === SOCKET_A
  );
  if (m.payload.codigo !== codigo) throw new Error(`código inesperado: ${m.payload.codigo}`);
});

await check('evento evt:PlayerRoomJoined publicado con datos del jugador A', async () => {
  const m = await waitFor(m =>
    m.channel === 'evt:PlayerRoomJoined' && m.data?.playerId === PLAYER_A
  );
  if (m.data.codigo !== codigo) throw new Error(`código incorrecto: ${m.data.codigo}`);
});

// ── TEST 2: Unirse a la sala ──────────────────────────────────────────────────

console.log('\n\x1b[1m[2] room:join — segundo jugador\x1b[0m');

await send('room:join', {
  socketId: SOCKET_B,
  codigo,
  playerId: PLAYER_B,
  name:     'Jugador B',
});

await check('gateway recibe room:join-socket-room para jugador B', async () => {
  await waitFor(m =>
    m.channel === 'gw:broadcast' && m.event === 'room:join-socket-room' && m.roomId === SOCKET_B
  );
});

await check('broadcast room:joined con 2 jugadores en el array', async () => {
  const m = await waitFor(m =>
    m.channel === 'gw:broadcast' && m.event === 'room:joined' && m.roomId === codigo
  );
  const n = m.payload.jugadores?.length;
  if (n !== 2) throw new Error(`esperaba 2 jugadores, llegaron ${n}`);
});

await check('evt:PlayerRoomJoined publicado para jugador B', async () => {
  await waitFor(m =>
    m.channel === 'evt:PlayerRoomJoined' && m.data?.playerId === PLAYER_B
  );
});

await check('evt:RoomReady publicado (sala 1v1 llena) con equipos', async () => {
  const m = await waitFor(m =>
    m.channel === 'evt:RoomReady' && m.data?.codigo === codigo
  );
  const eq = m.data.equipos;
  if (!eq?.A || !eq?.B) throw new Error('falta campo equipos.A / equipos.B');
  console.log(`    \x1b[90m→ equipo A: ${eq.A}  |  equipo B: ${eq.B}\x1b[0m`);
});

// ── TEST 3: Desconexión jugador A ─────────────────────────────────────────────

console.log('\n\x1b[1m[3] PlayerDisconnected — jugador A\x1b[0m');

await send('PlayerDisconnected', {
  socketId: SOCKET_A,
  playerId: PLAYER_A,
});

await check('evt:PlayerDisconnectedFromRoom para jugador A', async () => {
  const m = await waitFor(m =>
    m.channel === 'evt:PlayerDisconnectedFromRoom' && m.data?.playerId === PLAYER_A
  );
  if (m.data.codigo !== codigo) throw new Error(`código incorrecto: ${m.data.codigo}`);
});

await check('sala NO se destruye todavía (jugador B sigue conectado)', async () => {
  let destruida = false;
  try {
    await waitFor(m => m.channel === 'evt:RoomDestroyed' && m.data?.codigo === codigo, 1500);
    destruida = true;
  } catch { /* timeout esperado — la sala no debe destruirse aquí */ }
  if (destruida) throw new Error('la sala se destruyó antes de tiempo');
});

// ── TEST 4: Desconexión jugador B → sala destruida ────────────────────────────

console.log('\n\x1b[1m[4] PlayerDisconnected — jugador B (todos desconectados)\x1b[0m');

await send('PlayerDisconnected', {
  socketId: SOCKET_B,
  playerId: PLAYER_B,
});

await check('evt:PlayerDisconnectedFromRoom para jugador B', async () => {
  await waitFor(m =>
    m.channel === 'evt:PlayerDisconnectedFromRoom' && m.data?.playerId === PLAYER_B
  );
});

await check('evt:RoomDestroyed publicado al quedar sala vacía', async () => {
  const m = await waitFor(m =>
    m.channel === 'evt:RoomDestroyed' && m.data?.codigo === codigo
  );
  console.log(`    \x1b[90m→ sala ${m.data.codigo} destruida correctamente\x1b[0m`);
});

// ── TEST 5: Error — sala inexistente ──────────────────────────────────────────

console.log('\n\x1b[1m[5] room:join sala inexistente\x1b[0m');

await send('room:join', {
  socketId: SOCKET_C,
  codigo:   '000000',
  playerId: `player-C-${RUN}`,
  name:     'Jugador C',
});

await check('room service responde con room:error sala_no_existe', async () => {
  const m = await waitFor(m =>
    m.channel === 'gw:broadcast' && m.event === 'room:error' && m.roomId === SOCKET_C
  );
  if (m.payload.error !== 'sala_no_existe') throw new Error(`error inesperado: ${m.payload.error}`);
});

// ── TEST 6: Error — modo inválido ─────────────────────────────────────────────

console.log('\n\x1b[1m[6] room:create modo inválido\x1b[0m');

await send('room:create', {
  socketId: SOCKET_D,
  modo:     '3v3',
  playerId: `player-D-${RUN}`,
  name:     'Jugador D',
});

await check('room service responde con room:error modo_invalido', async () => {
  const m = await waitFor(m =>
    m.channel === 'gw:broadcast' && m.event === 'room:error' && m.roomId === SOCKET_D
  );
  if (m.payload.error !== 'modo_invalido') throw new Error(`error inesperado: ${m.payload.error}`);
});

// ── Limpieza ──────────────────────────────────────────────────────────────────

if (codigo) await pub.del(`sala:${codigo}`);

// ── Resultado ─────────────────────────────────────────────────────────────────

const color = failed === 0 ? '\x1b[32m' : '\x1b[31m';
console.log(`\n${'─'.repeat(52)}`);
console.log(`${color}Resultado: ${passed} pasaron, ${failed} fallaron\x1b[0m`);
console.log('─'.repeat(52) + '\n');

pub.disconnect();
sub.disconnect();
process.exit(failed > 0 ? 1 : 0);

import 'dotenv/config';
import { createRedis } from './redis.js';
import { producer, createConsumer } from './kafka.js';
import { log } from './logger.js';
import {
  validarModo, generarCodigo, crearSala,
  agregarJugador, marcarDesconectado,
  todosDesconectados, calcularEquipos, estaLlena,
  cambiarEquipo, puedeComenzar, quitarJugador,
} from './domain/room.js';

// Redis — solo estado (sala:{codigo})
const redis = createRedis();
await redis.connect();

// Índice inverso jugador→sala: permite reencontrar la sala de un jugador en O(1) al reconectar
// (gateway) o desconectar, en vez de escanear TODO el keyspace con KEYS 'sala:*' (O(N),
// bloqueante). Se escribe al unirse; el gateway lo lee y refresca; se borra al destruir la sala.
const IDX_TTL_SEG = 60 * 60 * 12; // 12 h — cubre cualquier partida.
const idxJugador = (playerId) => `jugador:${playerId}:sala`;
const setIndiceJugador = (playerId, codigo) => redis.set(idxJugador(playerId), codigo, 'EX', IDX_TTL_SEG);
const borrarIndiceJugador = (playerId) => redis.del(idxJugador(playerId));

// Conjunto de salas activas: permite a observability contar el pico de salas concurrentes con
// SCARD (O(1)) en vez de KEYS 'sala:*' (O(N)) en cada evento. SADD al crear, SREM al destruir.
const SALAS_ACTIVAS = 'salas:activas';

// TTL de la sala en Redis (el game lo refresca en cada acción vía broadcastState). Aquí se aplica
// al crear/unir y se refresca al desconectar, para que las salas abandonadas antes de empezar la
// partida (LOBBY/COLOCACION) también expiren solas y no queden como zombis.
const SALA_TTL_SEG = 60 * 60 * 6; // 6 h.
// Al destruir una sala se borran la clave principal y sus subclaves de una vez.
const borrarSala = (codigo) => redis.del(
  `sala:${codigo}`, `sala:${codigo}:energia:A`, `sala:${codigo}:energia:B`, `sala:${codigo}:chat`,
);

// Kafka — mensajería
await producer.connect();
const consumer = createConsumer('room-group');
await consumer.connect();
await consumer.subscribe({ topics: ['cmd.room'], fromBeginning: false });
log.info('suscrito a cmd.room');

await consumer.run({
  eachMessage: async ({ message }) => {
    try {
      const msg = JSON.parse(message.value.toString());
      if      (msg.type === 'room:create')          await handleCreate(msg.data);
      else if (msg.type === 'room:join')            await handleJoin(msg.data);
      else if (msg.type === 'room:cambiar-equipo')  await handleCambiarEquipo(msg.data);
      else if (msg.type === 'room:comenzar')        await handleComenzar(msg.data);
      else if (msg.type === 'room:salir')           await handleSalir(msg.data);
      else if (msg.type === 'PlayerDisconnected')   await handleDisconnect(msg.data);
    } catch (err) {
      log.error('mensaje no procesado —', err.message);
    }
  },
});

// ── Handlers (orquestación: Redis State + domain puro) ────────────────────────

async function handleCreate({ socketId, modo, playerId, name }) {
  try { validarModo(modo); } catch {
    await broadcast(socketId, 'room:error', { error: 'modo_invalido' });
    return;
  }

  const codigo = generarCodigo();
  const sala   = crearSala(codigo, modo, playerId, name, socketId);

  await redis.set(`sala:${codigo}`, JSON.stringify(sala), 'EX', SALA_TTL_SEG);
  await setIndiceJugador(playerId, codigo);
  await redis.sadd(SALAS_ACTIVAS, codigo);
  log.info(`sala creada: ${codigo} — modo: ${modo}`);

  await broadcast(socketId, 'room:created', { codigo, modo });
  await broadcast(socketId, 'room:join-socket-room', { codigo });
  await publish('PlayerRoomJoined', { codigo, playerId, name });

  // 1v1-bot se llena al crear → arranca solo. 1v1/2v2 esperan a que el anfitrión pulse "Comenzar".
  // Al creador se le envía el estado directo a su socket (aún es el único en la sala) para evitar
  // depender del orden con el "join-socket-room".
  if (estaLlena(sala)) await publicarRoomReady(sala);
  else await emitirSala(socketId, sala);
}

async function handleJoin({ socketId, codigo, playerId, name }) {
  const raw = await redis.get(`sala:${codigo}`);
  if (!raw) {
    await broadcast(socketId, 'room:error', { error: 'sala_no_existe' });
    return;
  }

  const sala = JSON.parse(raw);
  let equipo;
  try {
    equipo = agregarJugador(sala, playerId, name, socketId);
  } catch (err) {
    await broadcast(socketId, 'room:error', { error: err.message }); // sala_llena | ya_estas_en_la_sala
    log.warn(`no se pudo unir a ${codigo} — ${err.message}`);
    return;
  }

  await redis.set(`sala:${codigo}`, JSON.stringify(sala), 'EX', SALA_TTL_SEG);
  await setIndiceJugador(playerId, codigo);
  log.info(`jugador ${playerId} unido a sala ${codigo} — equipo ${equipo}`);

  await broadcast(socketId, 'room:join-socket-room', { codigo });
  await publish('PlayerRoomJoined', { codigo, playerId, name });

  // Antes la sala arrancaba automáticamente al llenarse. Ahora espera a que el anfitrión pulse
  // "Comenzar" — así en 2v2 los jugadores tienen tiempo de elegir bando mientras se unen los demás.
  await emitirSala(codigo, sala);
}

// Elegir bando en el lobby (2v2 o cambiar de lado en 1v1).
async function handleCambiarEquipo({ socketId, codigo, playerId, equipo }) {
  const raw = await redis.get(`sala:${codigo}`);
  if (!raw) return;
  const sala = JSON.parse(raw);
  try {
    cambiarEquipo(sala, playerId, equipo);
  } catch (err) {
    await broadcast(socketId, 'room:error', { error: err.message });
    return;
  }
  await redis.set(`sala:${codigo}`, JSON.stringify(sala), 'EX', SALA_TTL_SEG);
  await emitirSala(codigo, sala);
}

// El anfitrión inicia la partida (sala llena y bandos completos).
async function handleComenzar({ socketId, codigo, playerId }) {
  const raw = await redis.get(`sala:${codigo}`);
  if (!raw) return;
  const sala = JSON.parse(raw);
  if (sala.hostId !== playerId) { await broadcast(socketId, 'room:error', { error: 'solo_anfitrion' }); return; }
  if (!puedeComenzar(sala))     { await broadcast(socketId, 'room:error', { error: 'faltan_jugadores' }); return; }
  await publicarRoomReady(sala);
}

// Salir de la sala ("volver a seleccionar modo"). Si queda vacía se destruye.
async function handleSalir({ socketId, codigo, playerId }) {
  const raw = await redis.get(`sala:${codigo}`);
  if (!raw) return;
  const sala = JSON.parse(raw);
  if (!quitarJugador(sala, playerId)) return;

  await borrarIndiceJugador(playerId);
  await broadcast(socketId, 'room:left', { codigo });

  if (sala.jugadores.length === 0) {
    await redis.srem(SALAS_ACTIVAS, codigo);
    await borrarSala(codigo);
    await publish('RoomDestroyed', { codigo });
  } else {
    await redis.set(`sala:${codigo}`, JSON.stringify(sala), 'EX', SALA_TTL_SEG);
    await emitirSala(codigo, sala);
  }
}

async function handleDisconnect({ socketId, playerId }) {
  // O(1): el índice inverso nos da la sala del jugador directamente (antes: KEYS 'sala:*').
  const codigo = playerId ? await redis.get(idxJugador(playerId)) : null;
  if (!codigo) return;

  const raw = await redis.get(`sala:${codigo}`);
  if (!raw) { await borrarIndiceJugador(playerId); return; } // índice huérfano

  const sala    = JSON.parse(raw);
  const jugador = marcarDesconectado(sala, socketId, playerId);
  if (!jugador) return;

  // Re-aplica el TTL (SET lo borra) para que la sala siga viva por si alguien reconecta.
  await redis.set(`sala:${codigo}`, JSON.stringify(sala), 'EX', SALA_TTL_SEG);
  log.info(`jugador ${jugador.id} desconectado de sala ${sala.codigo}`);

  await publish('PlayerDisconnectedFromRoom', { codigo: sala.codigo, playerId: jugador.id });

  if (todosDesconectados(sala)) {
    log.info(`sala ${sala.codigo} sin jugadores — destruyendo`);
    // Nadie consume RoomDestroyed para borrar la clave → se borra aquí mismo (sala + subclaves),
    // junto con los índices de jugadores y la salida del conjunto de activas. Antes las salas
    // abandonadas quedaban como zombis para siempre.
    await Promise.all(sala.jugadores.map((j) => borrarIndiceJugador(j.id)));
    await redis.srem(SALAS_ACTIVAS, sala.codigo);
    await borrarSala(sala.codigo);
    await publish('RoomDestroyed', { codigo: sala.codigo });
  }
}

// ── Helpers de publicación ────────────────────────────────────────────────────

// Emite a TODA la sala el estado del lobby: jugadores (con su equipo), anfitrión y si ya se
// puede comenzar. El frontend lo usa para dibujar la lista, los botones de equipo y "Comenzar".
async function emitirSala(target, sala) {
  await broadcast(target, 'room:joined', {
    codigo:        sala.codigo,
    modo:          sala.modo,
    jugadores:     sala.jugadores,
    hostId:        sala.hostId,
    slotsMax:      sala.slotsMax,
    puedeComenzar: puedeComenzar(sala),
  });
}

async function broadcast(roomId, event, payload) {
  await producer.send({
    topic:    'gw.broadcast',
    messages: [{ key: roomId, value: JSON.stringify({ roomId, event, payload }) }],
  });
}

async function publish(type, data) {
  await producer.send({
    topic:    'evt.room',
    messages: [{ key: data.codigo, value: JSON.stringify({
      type, source: 'room', timestamp: Date.now(), data,
    })}],
  });
}

async function publicarRoomReady(sala) {
  log.info(`sala ${sala.codigo} lista — publicando RoomReady`);
  await publish('RoomReady', {
    codigo:    sala.codigo,
    modo:      sala.modo,
    equipos:   calcularEquipos(sala),
    jugadores: sala.jugadores,
  });
}

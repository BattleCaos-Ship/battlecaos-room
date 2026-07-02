import 'dotenv/config';
import { createRedis } from './redis.js';
import { producer, createConsumer } from './kafka.js';
import { log } from './logger.js';
import {
  validarModo, generarCodigo, crearSala,
  agregarJugador, marcarDesconectado,
  todosDesconectados, calcularEquipos, estaLlena,
} from './domain/room.js';

// Redis — solo estado (sala:{codigo})
const redis = createRedis();
await redis.connect();

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
      if      (msg.type === 'room:create')        await handleCreate(msg.data);
      else if (msg.type === 'room:join')          await handleJoin(msg.data);
      else if (msg.type === 'PlayerDisconnected') await handleDisconnect(msg.data);
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

  await redis.set(`sala:${codigo}`, JSON.stringify(sala));
  log.info(`sala creada: ${codigo} — modo: ${modo}`);

  await broadcast(socketId, 'room:created', { codigo, modo });
  await broadcast(socketId, 'room:join-socket-room', { codigo });
  await publish('PlayerRoomJoined', { codigo, playerId, name });

  if (estaLlena(sala)) await publicarRoomReady(sala);
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
  } catch {
    await broadcast(socketId, 'room:error', { error: 'sala_llena' });
    log.warn(`sala_llena — codigo: ${codigo}`);
    return;
  }

  await redis.set(`sala:${codigo}`, JSON.stringify(sala));
  log.info(`jugador ${playerId} unido a sala ${codigo} — equipo ${equipo}`);

  await broadcast(socketId, 'room:join-socket-room', { codigo });
  await broadcast(codigo, 'room:joined', { codigo, jugadores: sala.jugadores });
  await publish('PlayerRoomJoined', { codigo, playerId, name });

  if (estaLlena(sala)) await publicarRoomReady(sala);
}

async function handleDisconnect({ socketId, playerId }) {
  const keys = await redis.keys('sala:*');
  for (const key of keys) {
    if (key.split(':').length !== 2) continue;
    const raw = await redis.get(key);
    if (!raw) continue;

    const sala    = JSON.parse(raw);
    const jugador = marcarDesconectado(sala, socketId, playerId);
    if (!jugador) continue;

    await redis.set(key, JSON.stringify(sala));
    log.info(`jugador ${jugador.id} desconectado de sala ${sala.codigo}`);

    await publish('PlayerDisconnectedFromRoom', { codigo: sala.codigo, playerId: jugador.id });

    if (todosDesconectados(sala)) {
      log.info(`sala ${sala.codigo} sin jugadores — destruyendo`);
      await publish('RoomDestroyed', { codigo: sala.codigo });
    }
    break;
  }
}

// ── Helpers de publicación ────────────────────────────────────────────────────

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

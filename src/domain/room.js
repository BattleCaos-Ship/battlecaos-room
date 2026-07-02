// Funciones puras del dominio de salas.
// Sin imports de Redis, ioredis ni logger — testeables sin mocks.

const SLOTS = { '1v1': 2, '1v1-bot': 1, '2v2': 4 };

export function validarModo(modo) {
  if (!SLOTS[modo]) throw new Error('modo_invalido');
}

export function generarCodigo() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export function crearSala(codigo, modo, playerId, name, socketId) {
  validarModo(modo);
  return {
    codigo,
    modo,
    fase:      'LOBBY',
    jugadores: [{ id: playerId, name, socketId, equipo: 'A', conectado: true, desconectadoEn: null }],
    slotsMax:  SLOTS[modo],
    creadoEn:  Date.now(),
  };
}

export function asignarEquipo(sala) {
  // posición 0,2 → A; posición 1,3 → B
  return sala.jugadores.length % 2 === 0 ? 'A' : 'B';
}

export function estaLlena(sala) {
  return sala.jugadores.length >= sala.slotsMax;
}

export function agregarJugador(sala, playerId, name, socketId) {
  if (estaLlena(sala)) throw new Error('sala_llena');
  const equipo = asignarEquipo(sala);
  sala.jugadores.push({ id: playerId, name, socketId, equipo, conectado: true, desconectadoEn: null });
  return equipo;
}

export function marcarDesconectado(sala, socketId, playerId) {
  const jugador = sala.jugadores.find(
    (j) => j.socketId === socketId || (playerId && j.id === playerId)
  );
  if (!jugador) return null;
  jugador.conectado      = false;
  jugador.desconectadoEn = Date.now();
  return jugador;
}

export function todosDesconectados(sala) {
  return sala.jugadores.every((j) => !j.conectado);
}

export function calcularEquipos(sala) {
  const equipos = { A: [], B: [] };
  for (const j of sala.jugadores) equipos[j.equipo].push(j.id);
  return equipos;
}

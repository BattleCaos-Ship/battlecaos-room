// Funciones puras del dominio de salas.
// Sin imports de Redis, ioredis ni logger — testeables sin mocks.

const SLOTS = { '1v1': 2, '1v1-bot': 1, '2v2': 4 };
// Cupo por equipo: 2v2 admite 2 por bando; el resto, 1.
const maxPorEquipo = (modo) => (modo === '2v2' ? 2 : 1);

export function validarModo(modo) {
  if (!SLOTS[modo]) throw new Error('modo_invalido');
}

export function generarCodigo() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// Nombre visible de la sala (el CÓDIGO de 6 dígitos actúa como "contraseña" para unirse).
export function normalizarNombreSala(nombre, fallback = 'Sala de batalla') {
  const n = typeof nombre === 'string' ? nombre.trim().slice(0, 30) : '';
  return n.length >= 1 ? n : fallback;
}

export function crearSala(codigo, modo, playerId, name, socketId, nombreSala = null) {
  validarModo(modo);
  return {
    codigo,
    modo,
    nombre:    normalizarNombreSala(nombreSala, `Sala de ${name ?? 'batalla'}`),
    fase:      'LOBBY',
    hostId:    playerId, // el creador es el anfitrión (quien puede comenzar la partida)
    jugadores: [{ id: playerId, name, socketId, equipo: 'A', conectado: true, desconectadoEn: null }],
    slotsMax:  SLOTS[modo],
    creadoEn:  Date.now(),
  };
}

export function contarEquipo(sala, equipo) {
  return sala.jugadores.filter((j) => j.equipo === equipo).length;
}

export function asignarEquipo(sala) {
  // Equilibra: al equipo con menos jugadores (A ante empate).
  return contarEquipo(sala, 'A') <= contarEquipo(sala, 'B') ? 'A' : 'B';
}

export function estaLlena(sala) {
  return sala.jugadores.length >= sala.slotsMax;
}

export function agregarJugador(sala, playerId, name, socketId) {
  // La MISMA cuenta no puede unirse a una sala donde ya está (p.ej. abrir 2 pestañas con la misma
  // cuenta para probar un 1v1 contra sí mismo). Es un caso inválido, no una reconexión: la
  // reconexión la maneja el gateway aparte, sin pasar por room:join.
  if (sala.jugadores.some((j) => j.id === playerId)) throw new Error('ya_estas_en_la_sala');
  if (estaLlena(sala)) throw new Error('sala_llena');
  const equipo = asignarEquipo(sala);
  sala.jugadores.push({ id: playerId, name, socketId, equipo, conectado: true, desconectadoEn: null });
  return equipo;
}

// El jugador elige bando en el lobby de 2v2 (o cambia de lado en 1v1). Solo antes de empezar.
// Si el equipo destino está LLENO, aún puede entrar INTERCAMBIANDO lugar con un jugador de
// ese equipo (`swapConId`) — sin esto, con la sala llena nadie podía reorganizar los bandos.
export function cambiarEquipo(sala, playerId, equipo, swapConId = null) {
  if (sala.fase !== 'LOBBY') throw new Error('partida_en_curso');
  if (equipo !== 'A' && equipo !== 'B') throw new Error('equipo_invalido');
  const jugador = sala.jugadores.find((j) => j.id === playerId);
  if (!jugador) throw new Error('jugador_no_esta');
  if (jugador.equipo === equipo) return jugador; // ya está ahí, no-op
  if (contarEquipo(sala, equipo) >= maxPorEquipo(sala.modo)) {
    const otro = swapConId ? sala.jugadores.find((j) => j.id === swapConId) : null;
    if (!otro || otro.equipo !== equipo) throw new Error('equipo_lleno');
    otro.equipo = jugador.equipo; // intercambio: cada uno toma el bando del otro
    jugador.equipo = equipo;
    return jugador;
  }
  jugador.equipo = equipo;
  return jugador;
}

// ¿Se puede iniciar? Sala llena y bandos completos (2v2: 2 y 2; 1v1: 1 y 1).
export function puedeComenzar(sala) {
  if (!estaLlena(sala)) return false;
  if (sala.modo === '1v1-bot') return true;
  const n = maxPorEquipo(sala.modo);
  return contarEquipo(sala, 'A') === n && contarEquipo(sala, 'B') === n;
}

// Saca a un jugador de la sala (al "volver a seleccionar modo"). Si era el anfitrión, el rol
// pasa al siguiente jugador. Devuelve true si lo quitó.
export function quitarJugador(sala, playerId) {
  const antes = sala.jugadores.length;
  sala.jugadores = sala.jugadores.filter((j) => j.id !== playerId);
  if (sala.jugadores.length === antes) return false;
  if (sala.hostId === playerId) sala.hostId = sala.jugadores[0]?.id ?? null;
  return true;
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

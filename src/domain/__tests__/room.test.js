import { describe, it, expect, beforeEach } from 'vitest';
import {
  validarModo,
  generarCodigo,
  crearSala,
  asignarEquipo,
  estaLlena,
  agregarJugador,
  marcarDesconectado,
  todosDesconectados,
  calcularEquipos,
  cambiarEquipo,
  puedeComenzar,
  quitarJugador,
  contarEquipo,
} from '../room.js';

// ── validarModo ───────────────────────────────────────────────────────────────

describe('validarModo', () => {
  it('no lanza error para modo 1v1', () => {
    expect(() => validarModo('1v1')).not.toThrow();
  });

  it('no lanza error para modo 1v1-bot', () => {
    expect(() => validarModo('1v1-bot')).not.toThrow();
  });

  it('no lanza error para modo 2v2', () => {
    expect(() => validarModo('2v2')).not.toThrow();
  });

  it('lanza error para modo desconocido', () => {
    expect(() => validarModo('3v3')).toThrow('modo_invalido');
  });

  it('lanza error para modo vacío', () => {
    expect(() => validarModo('')).toThrow('modo_invalido');
  });
});

// ── generarCodigo ─────────────────────────────────────────────────────────────

describe('generarCodigo', () => {
  it('genera un string de exactamente 6 caracteres', () => {
    expect(generarCodigo()).toHaveLength(6);
  });

  it('genera solo dígitos numéricos', () => {
    expect(generarCodigo()).toMatch(/^\d{6}$/);
  });

  it('no empieza con 0 (siempre entre 100000 y 999999)', () => {
    for (let i = 0; i < 20; i++) {
      expect(Number(generarCodigo())).toBeGreaterThanOrEqual(100000);
    }
  });

  it('genera códigos distintos en llamadas sucesivas', () => {
    const codigos = new Set(Array.from({ length: 50 }, generarCodigo));
    expect(codigos.size).toBeGreaterThan(1);
  });
});

// ── crearSala ─────────────────────────────────────────────────────────────────

describe('crearSala', () => {
  it('crea sala con modo 1v1 y slotsMax 2', () => {
    const sala = crearSala('123456', '1v1', 'uid-A', 'JugadorA', 'socket-1');
    expect(sala.codigo).toBe('123456');
    expect(sala.modo).toBe('1v1');
    expect(sala.slotsMax).toBe(2);
    expect(sala.fase).toBe('LOBBY');
  });

  it('crea sala con modo 2v2 y slotsMax 4', () => {
    const sala = crearSala('654321', '2v2', 'uid-A', 'JugadorA', 'socket-1');
    expect(sala.slotsMax).toBe(4);
  });

  it('crea sala con modo 1v1-bot y slotsMax 1', () => {
    const sala = crearSala('111111', '1v1-bot', 'uid-A', 'JugadorA', 'socket-1');
    expect(sala.slotsMax).toBe(1);
  });

  it('asigna el creador al equipo A', () => {
    const sala = crearSala('123456', '1v1', 'uid-A', 'JugadorA', 'socket-1');
    expect(sala.jugadores[0].equipo).toBe('A');
  });

  it('el creador queda conectado', () => {
    const sala = crearSala('123456', '1v1', 'uid-A', 'JugadorA', 'socket-1');
    expect(sala.jugadores[0].conectado).toBe(true);
    expect(sala.jugadores[0].desconectadoEn).toBeNull();
  });

  it('guarda el socketId del creador', () => {
    const sala = crearSala('123456', '1v1', 'uid-A', 'JugadorA', 'socket-1');
    expect(sala.jugadores[0].socketId).toBe('socket-1');
  });

  it('lanza error si el modo es inválido', () => {
    expect(() => crearSala('123456', 'invalid', 'uid-A', 'JugadorA', 'socket-1'))
      .toThrow('modo_invalido');
  });
});

// ── asignarEquipo ─────────────────────────────────────────────────────────────

describe('asignarEquipo', () => {
  it('posición 0 → equipo A (1v1: jugador 1)', () => {
    const sala = crearSala('123456', '1v1', 'uid-A', 'JugadorA', 's1');
    sala.jugadores = []; // vaciar para probar posición 0
    expect(asignarEquipo(sala)).toBe('A');
  });

  it('posición 1 → equipo B (1v1: jugador 2)', () => {
    const sala = crearSala('123456', '1v1', 'uid-A', 'JugadorA', 's1');
    // ya tiene 1 jugador (posición 0 ocupada)
    expect(asignarEquipo(sala)).toBe('B');
  });

  it('posición 2 → equipo A (2v2: tercer jugador)', () => {
    const sala = crearSala('123456', '2v2', 'uid-A', 'JugadorA', 's1');
    sala.jugadores.push({ id: 'uid-B', equipo: 'B', conectado: true });
    expect(asignarEquipo(sala)).toBe('A');
  });

  it('posición 3 → equipo B (2v2: cuarto jugador)', () => {
    const sala = crearSala('123456', '2v2', 'uid-A', 'JugadorA', 's1');
    sala.jugadores.push(
      { id: 'uid-B', equipo: 'B', conectado: true },
      { id: 'uid-C', equipo: 'A', conectado: true },
    );
    expect(asignarEquipo(sala)).toBe('B');
  });
});

// ── estaLlena ─────────────────────────────────────────────────────────────────

describe('estaLlena', () => {
  it('sala 1v1 con 1 jugador no está llena', () => {
    const sala = crearSala('123456', '1v1', 'uid-A', 'A', 's1');
    expect(estaLlena(sala)).toBe(false);
  });

  it('sala 1v1 con 2 jugadores está llena', () => {
    const sala = crearSala('123456', '1v1', 'uid-A', 'A', 's1');
    sala.jugadores.push({ id: 'uid-B', equipo: 'B', conectado: true });
    expect(estaLlena(sala)).toBe(true);
  });

  it('sala 1v1-bot con 1 jugador está llena de inmediato', () => {
    const sala = crearSala('123456', '1v1-bot', 'uid-A', 'A', 's1');
    expect(estaLlena(sala)).toBe(true);
  });

  it('sala 2v2 con 3 jugadores no está llena', () => {
    const sala = crearSala('123456', '2v2', 'uid-A', 'A', 's1');
    sala.jugadores.push(
      { id: 'uid-B', equipo: 'B', conectado: true },
      { id: 'uid-C', equipo: 'A', conectado: true },
    );
    expect(estaLlena(sala)).toBe(false);
  });
});

// ── agregarJugador ────────────────────────────────────────────────────────────

describe('agregarJugador', () => {
  let sala;
  beforeEach(() => {
    sala = crearSala('123456', '1v1', 'uid-A', 'JugadorA', 'socket-1');
  });

  it('agrega al segundo jugador con equipo B', () => {
    const equipo = agregarJugador(sala, 'uid-B', 'JugadorB', 'socket-2');
    expect(equipo).toBe('B');
    expect(sala.jugadores).toHaveLength(2);
    expect(sala.jugadores[1].id).toBe('uid-B');
    expect(sala.jugadores[1].equipo).toBe('B');
    expect(sala.jugadores[1].conectado).toBe(true);
  });

  it('el jugador agregado queda conectado', () => {
    agregarJugador(sala, 'uid-B', 'JugadorB', 'socket-2');
    expect(sala.jugadores[1].conectado).toBe(true);
    expect(sala.jugadores[1].desconectadoEn).toBeNull();
  });

  it('lanza error si la sala ya está llena', () => {
    agregarJugador(sala, 'uid-B', 'JugadorB', 'socket-2');
    expect(() => agregarJugador(sala, 'uid-C', 'JugadorC', 'socket-3'))
      .toThrow('sala_llena');
  });

  it('lanza error si la MISMA cuenta intenta unirse a su propia sala', () => {
    // uid-A ya es el creador; no puede volver a unirse (probar 1v1 contra sí mismo).
    expect(() => agregarJugador(sala, 'uid-A', 'JugadorA', 'socket-otra'))
      .toThrow('ya_estas_en_la_sala');
    expect(sala.jugadores).toHaveLength(1);
  });

  it('no modifica la sala si lanza error', () => {
    agregarJugador(sala, 'uid-B', 'JugadorB', 'socket-2');
    try { agregarJugador(sala, 'uid-C', 'JugadorC', 'socket-3'); } catch {}
    expect(sala.jugadores).toHaveLength(2);
  });
});

// ── marcarDesconectado ────────────────────────────────────────────────────────

describe('marcarDesconectado', () => {
  let sala;
  beforeEach(() => {
    sala = crearSala('123456', '1v1', 'uid-A', 'JugadorA', 'socket-1');
    agregarJugador(sala, 'uid-B', 'JugadorB', 'socket-2');
  });

  it('encuentra al jugador por socketId y lo marca desconectado', () => {
    const jugador = marcarDesconectado(sala, 'socket-1', null);
    expect(jugador).not.toBeNull();
    expect(jugador.conectado).toBe(false);
    expect(jugador.desconectadoEn).toBeTypeOf('number');
  });

  it('encuentra al jugador por playerId', () => {
    const jugador = marcarDesconectado(sala, 'socket-inexistente', 'uid-B');
    expect(jugador.id).toBe('uid-B');
    expect(jugador.conectado).toBe(false);
  });

  it('NO elimina al jugador del array', () => {
    marcarDesconectado(sala, 'socket-1', null);
    expect(sala.jugadores).toHaveLength(2);
  });

  it('conserva la flota y datos del jugador desconectado', () => {
    marcarDesconectado(sala, 'socket-1', null);
    const jugador = sala.jugadores.find((j) => j.id === 'uid-A');
    expect(jugador.id).toBe('uid-A');
    expect(jugador.equipo).toBe('A');
  });

  it('devuelve null si el jugador no existe en la sala', () => {
    const resultado = marcarDesconectado(sala, 'socket-inexistente', null);
    expect(resultado).toBeNull();
  });

  it('no modifica otros jugadores al desconectar uno', () => {
    marcarDesconectado(sala, 'socket-1', null);
    const jugadorB = sala.jugadores.find((j) => j.id === 'uid-B');
    expect(jugadorB.conectado).toBe(true);
  });
});

// ── todosDesconectados ────────────────────────────────────────────────────────

describe('todosDesconectados', () => {
  let sala;
  beforeEach(() => {
    sala = crearSala('123456', '1v1', 'uid-A', 'JugadorA', 'socket-1');
    agregarJugador(sala, 'uid-B', 'JugadorB', 'socket-2');
  });

  it('devuelve false si todos están conectados', () => {
    expect(todosDesconectados(sala)).toBe(false);
  });

  it('devuelve false si solo uno está desconectado', () => {
    marcarDesconectado(sala, 'socket-1', null);
    expect(todosDesconectados(sala)).toBe(false);
  });

  it('devuelve true si todos están desconectados', () => {
    marcarDesconectado(sala, 'socket-1', null);
    marcarDesconectado(sala, 'socket-2', null);
    expect(todosDesconectados(sala)).toBe(true);
  });
});

// ── calcularEquipos ───────────────────────────────────────────────────────────

describe('calcularEquipos', () => {
  it('devuelve los IDs separados por equipo en 1v1', () => {
    const sala = crearSala('123456', '1v1', 'uid-A', 'JugadorA', 's1');
    agregarJugador(sala, 'uid-B', 'JugadorB', 's2');
    const equipos = calcularEquipos(sala);
    expect(equipos.A).toContain('uid-A');
    expect(equipos.B).toContain('uid-B');
  });

  it('devuelve 2 jugadores por equipo en 2v2', () => {
    const sala = crearSala('123456', '2v2', 'uid-A', 'A', 's1');
    agregarJugador(sala, 'uid-B', 'B', 's2');
    agregarJugador(sala, 'uid-C', 'C', 's3');
    agregarJugador(sala, 'uid-D', 'D', 's4');
    const equipos = calcularEquipos(sala);
    expect(equipos.A).toHaveLength(2);
    expect(equipos.B).toHaveLength(2);
  });
});

// ── Lobby: host, cambiar equipo, comenzar, salir ──────────────────────────────

describe('crearSala — anfitrión', () => {
  it('el creador queda como hostId', () => {
    const s = crearSala('111111', '2v2', 'p1', 'Ana', 'sock1');
    expect(s.hostId).toBe('p1');
    expect(s.fase).toBe('LOBBY');
  });
});

describe('cambiarEquipo', () => {
  const sala2v2 = () => {
    const s = crearSala('222222', '2v2', 'p1', 'Ana', 's1');   // A
    agregarJugador(s, 'p2', 'Beto', 's2');                     // B (balanceo)
    agregarJugador(s, 'p3', 'Cami', 's3');                     // A
    agregarJugador(s, 'p4', 'Dani', 's4');                     // B
    return s;
  };

  it('mueve al jugador al equipo pedido si hay cupo', () => {
    const s = crearSala('222222', '2v2', 'p1', 'Ana', 's1'); // A
    agregarJugador(s, 'p2', 'Beto', 's2');                   // B
    cambiarEquipo(s, 'p2', 'A');
    expect(s.jugadores.find((j) => j.id === 'p2').equipo).toBe('A');
  });

  it('rechaza si el equipo destino está lleno (2v2: máx 2)', () => {
    const s = sala2v2(); // A: p1,p3  B: p2,p4
    expect(() => cambiarEquipo(s, 'p2', 'A')).toThrow('equipo_lleno');
  });

  it('rechaza fuera del lobby', () => {
    const s = sala2v2();
    s.fase = 'TURNOS';
    expect(() => cambiarEquipo(s, 'p2', 'A')).toThrow('partida_en_curso');
  });

  it('rechaza equipo inválido', () => {
    const s = sala2v2();
    expect(() => cambiarEquipo(s, 'p2', 'Z')).toThrow('equipo_invalido');
  });
});

describe('puedeComenzar', () => {
  it('falso si la sala no está llena', () => {
    const s = crearSala('333333', '2v2', 'p1', 'Ana', 's1');
    expect(puedeComenzar(s)).toBe(false);
  });

  it('verdadero en 2v2 con 2 y 2', () => {
    const s = crearSala('333333', '2v2', 'p1', 'Ana', 's1');
    agregarJugador(s, 'p2', 'B', 's2');
    agregarJugador(s, 'p3', 'C', 's3');
    agregarJugador(s, 'p4', 'D', 's4');
    expect(contarEquipo(s, 'A')).toBe(2);
    expect(contarEquipo(s, 'B')).toBe(2);
    expect(puedeComenzar(s)).toBe(true);
  });

  it('verdadero en 1v1 con 1 y 1', () => {
    const s = crearSala('333333', '1v1', 'p1', 'Ana', 's1');
    agregarJugador(s, 'p2', 'B', 's2');
    expect(puedeComenzar(s)).toBe(true);
  });
});

describe('quitarJugador', () => {
  it('saca al jugador y reasigna el anfitrión si era el host', () => {
    const s = crearSala('444444', '2v2', 'p1', 'Ana', 's1');
    agregarJugador(s, 'p2', 'Beto', 's2');
    expect(quitarJugador(s, 'p1')).toBe(true);
    expect(s.jugadores.some((j) => j.id === 'p1')).toBe(false);
    expect(s.hostId).toBe('p2'); // el rol pasó al siguiente
  });

  it('devuelve false si el jugador no estaba', () => {
    const s = crearSala('444444', '1v1', 'p1', 'Ana', 's1');
    expect(quitarJugador(s, 'nadie')).toBe(false);
  });
});

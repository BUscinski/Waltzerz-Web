const { releaseCode } = require("../lib/rooms");

function randomColor() {
  let color;
  do {
    const n = Math.floor(Math.random() * 0xffffff);
    const r = (n >> 16) & 0xff;
    const g = (n >> 8) & 0xff;
    const b = n & 0xff;
    // reject if red-dominant (looks red/orange/pink)
    if (r > 180 && g < 100 && b < 100) continue;
    color = '#' + n.toString(16).padStart(6, '0');
  } while (!color);
  return color;
}

module.exports = function setupWaltzers(ns) {
  const rooms = {};

  function initRoom(roomCode) {
    const emit = (...args) => ns.to(roomCode).emit(...args);

    const state = {
      players: {},
      phase: "slow",
      timer: null,
      running: false,
      config: { minTime: 7, maxTime: 20, slowMult: 5, fastMult: 15 },
    };

    function scheduleNextPhase() {
      const { minTime, maxTime } = state.config;
      const delay = (minTime + Math.random() * (maxTime - minTime)) * 1000;
      state.timer = setTimeout(togglePhase, delay);
    }

    function togglePhase() {
      if (!state.running) return;
      state.phase = state.phase === "slow" ? "fast" : "slow";
      const multiplier = state.phase === "slow" ? state.config.slowMult : state.config.fastMult;
      emit("phase_change", { phase: state.phase, multiplier });
      console.log(`Waltzers [${roomCode}]: phase → ${state.phase} (×${multiplier})`);
      scheduleNextPhase();
    }

    function stop() {
      state.running = false;
      clearTimeout(state.timer);
      state.timer = null;
    }

    const room = { state, emit, scheduleNextPhase, stop };
    rooms[roomCode] = room;
    return room;
  }

  ns.on("connection", socket => {
    console.log("Waltzers connected:", socket.id);
    let roomCode = null;
    const rm = () => rooms[roomCode];

    socket.on("host_room", ({ roomCode: code }) => {
      roomCode = code;
      if (!rooms[roomCode]) initRoom(roomCode);
      socket.join(roomCode);
      // Send current config so the host debug inputs reflect server defaults
      socket.emit("room_config", rooms[roomCode].state.config);
      console.log(`Waltzers host joined room: ${roomCode}`);
    });

    socket.on("join_room", ({ code, name }) => {
      const uc = code?.trim().toUpperCase();
      if (!rooms[uc]) {
        socket.emit("room_error", { error: `Room "${uc}" not found.` });
        return;
      }
      roomCode = uc;
      socket.join(roomCode);
      const r = rm();
      const color = randomColor();
      r.state.players[socket.id] = { name, color, out: false };
      r.emit("player_joined", { id: socket.id, name, color });
      console.log(`Waltzers [${roomCode}]: ${name} joined`);
    });

    socket.on("start_game", () => {
      const r = rm();
      if (!r) return;
      for (const id in r.state.players) r.state.players[id].out = false;
      r.state.phase = "slow";
      r.state.running = true;
      r.state.startTime = Date.now();
      const mult = r.state.config.slowMult;
      r.emit("game_started", { phase: "slow", multiplier: mult });
      r.scheduleNextPhase();
      console.log(`Waltzers [${roomCode}]: game started`);
    });

    socket.on("stop_game", () => {
      const r = rm();
      if (!r) return;
      r.stop();
      r.emit("game_stopped");
    });

    socket.on("phase_config", ({ minTime, maxTime, slowMult, fastMult }) => {
      const r = rm();
      if (!r) return;
      r.state.config = { minTime, maxTime, slowMult, fastMult };
    });

    socket.on("player_hit", () => {
      const r = rm();
      if (!r || !r.state.running) return;
      const player = r.state.players[socket.id];
      if (!player || player.out) return;
      player.out = true;
      const survivedMs = r.state.startTime ? Date.now() - r.state.startTime : null;
      r.emit("player_out", { id: socket.id, name: player.name, survivedMs });
      // TODO: trigger elimination SFX on host here (e.g. emit a play_sfx event or call an audio helper)
      console.log(`Waltzers [${roomCode}]: ${player.name} is out`);

      const alive = Object.values(r.state.players).filter(p => !p.out);
      if (alive.length <= 1) {
        r.stop();
        r.emit("game_over", { winner: alive[0]?.name ?? null });
        console.log(`Waltzers [${roomCode}]: game over — winner: ${alive[0]?.name ?? "none"}`);
      }
    });

    socket.on("reset", () => {
      const r = rm();
      if (!r) return;
      r.stop();
      r.state.phase = "slow";
      for (const id in r.state.players) r.state.players[id].out = false;
      r.emit("reset");
    });

    socket.on("disconnect", () => {
      const r = rm();
      if (!r || !r.state.players[socket.id]) return;
      const { name } = r.state.players[socket.id];
      r.emit("player_left", { id: socket.id, name });
      delete r.state.players[socket.id];
      console.log(`Waltzers [${roomCode}]: ${name} disconnected`);

      if (Object.keys(r.state.players).length === 0) {
        setTimeout(() => {
          if (rooms[roomCode] && Object.keys(rooms[roomCode].state.players).length === 0) {
            rooms[roomCode].stop();
            delete rooms[roomCode];
            releaseCode(roomCode);
            console.log(`Waltzers room ${roomCode} cleaned up`);
          }
        }, 5 * 60 * 1000);
      }
    });
  });
};

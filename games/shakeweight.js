const { releaseCode } = require("../lib/rooms");

function randomColor() {
  return "#" + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0");
}

module.exports = function setupShakeweight(ns) {
  const rooms = {}; // roomCode → { players, state }

  function initRoom(roomCode) {
    const emit = (...args) => ns.to(roomCode).emit(...args);
    const room = {
      players: {},
      state: {
        active: false,
        threshold: 500,
        scores: {},
        countdownInterval: null,
      },
      emit,
    };
    rooms[roomCode] = room;
    return room;
  }

  ns.on("connection", socket => {
    console.log("ShakeWeight connected:", socket.id);
    let roomCode = null;
    const rm = () => rooms[roomCode];

    socket.on("host_room", ({ roomCode: code }) => {
      roomCode = code;
      if (!rooms[roomCode]) initRoom(roomCode);
      socket.join(roomCode);
      console.log(`Shakeweight host joined room: ${roomCode}`);
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
      r.players[socket.id] = { name, color };
      r.state.scores[socket.id] = 0;
      r.emit("player_joined", { playerId: socket.id, playerName: name });
    });

    socket.on("start_shakeweight_game", ({ threshold }) => {
      const r = rm();
      if (!r) return;
      r.state.active = true;
      r.state.threshold = threshold || 500;
      r.state.scores = {};
      for (const id in r.players) r.state.scores[id] = 0;

      r.emit("game_started");

      let countdown = 3;
      r.state.countdownInterval = setInterval(() => {
        r.emit("countdown", { time: countdown });
        countdown--;
        if (countdown < 0) {
          clearInterval(r.state.countdownInterval);
          r.emit("countdown", { time: 0 });
        }
      }, 1000);
    });

    socket.on("jerk_update", ({ score }) => {
      const r = rm();
      if (!r || !r.state.active || !r.players[socket.id]) return;
      r.state.scores[socket.id] = score;
      r.emit("jerk_scores_update", { scores: r.state.scores });

      if (score >= r.state.threshold) {
        r.state.active = false;
        clearInterval(r.state.countdownInterval);
        r.emit("game_ended", {
          winner: { id: socket.id, name: r.players[socket.id].name },
          finalScores: r.state.scores,
        });
      }
    });

    socket.on("reset_shakeweight_game", () => {
      const r = rm();
      if (!r) return;
      r.state.active = false;
      r.state.scores = {};
      if (r.state.countdownInterval) clearInterval(r.state.countdownInterval);
      r.emit("reset_game");
    });

    socket.on("disconnect", () => {
      const r = rm();
      if (!r || !r.players[socket.id]) return;
      r.emit("player_left", { playerId: socket.id });
      delete r.state.scores[socket.id];
      delete r.players[socket.id];

      if (Object.keys(r.players).length === 0) {
        setTimeout(() => {
          if (rooms[roomCode] && Object.keys(rooms[roomCode].players).length === 0) {
            delete rooms[roomCode];
            releaseCode(roomCode);
            console.log(`Shakeweight room ${roomCode} cleaned up`);
          }
        }, 5 * 60 * 1000);
      }
    });
  });
};

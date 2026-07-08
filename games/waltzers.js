const { releaseCode } = require("../lib/rooms");

module.exports = function setupWaltzers(ns) {
  const rooms = {}; // roomCode → { players }

  function initRoom(roomCode) {
    const emit = (...args) => ns.to(roomCode).emit(...args);
    const room = { players: {}, emit };
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
      r.players[socket.id] = { name, out: false };
      r.emit("player_joined", { id: socket.id, name });
    });

    socket.on("imu", data => rm()?.emit("imu_broadcast", { id: socket.id, data }));

    socket.on("jerk", data => {
      const r = rm();
      if (!r) return;
      if (r.players[socket.id]) r.players[socket.id].out = true;
      r.emit("player_out", { id: socket.id });
      r.emit("jerk_broadcast", { id: socket.id, ...data });
    });

    socket.on("update_thresholds", data => rm()?.emit("update_thresholds", data));

    socket.on("reset", () => {
      const r = rm();
      if (!r) return;
      for (const id in r.players) r.players[id].out = false;
      r.emit("reset");
    });

    socket.on("disconnect", () => {
      const r = rm();
      if (!r || !r.players[socket.id]) return;
      r.emit("player_left", { id: socket.id });
      delete r.players[socket.id];

      if (Object.keys(r.players).length === 0) {
        setTimeout(() => {
          if (rooms[roomCode] && Object.keys(rooms[roomCode].players).length === 0) {
            delete rooms[roomCode];
            releaseCode(roomCode);
            console.log(`Waltzers room ${roomCode} cleaned up`);
          }
        }, 5 * 60 * 1000);
      }
    });
  });
};

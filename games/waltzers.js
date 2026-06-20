module.exports = function setupWaltzers(ns) {
  const players = {};

  ns.on("connection", socket => {
    console.log("Waltzers connected:", socket.id);

    socket.on("join", ({ name }) => {
      players[socket.id] = { name, out: false };
      ns.emit("player_joined", { id: socket.id, name });
    });

    socket.on("imu", data => {
      ns.emit("imu_broadcast", { id: socket.id, data });
    });

    socket.on("jerk", data => {
      if (players[socket.id]) players[socket.id].out = true;
      ns.emit("player_out", { id: socket.id });
      ns.emit("jerk_broadcast", { id: socket.id, ...data });
    });

    socket.on("update_thresholds", data => {
      ns.emit("update_thresholds", data);
    });

    socket.on("reset", () => {
      for (const id in players) players[id].out = false;
      ns.emit("reset");
    });

    socket.on("disconnect", () => {
      if (!players[socket.id]) return;
      ns.emit("player_left", { id: socket.id });
      delete players[socket.id];
    });
  });
};

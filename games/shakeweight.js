function randomColor() {
  return "#" + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0");
}

module.exports = function setupShakeweight(ns) {
  const players = {};
  let gameState = {
    active: false,
    threshold: 500,
    scores: {},
    countdownInterval: null,
  };

  ns.on("connection", socket => {
    console.log("ShakeWeight connected:", socket.id);

    socket.on("join", ({ name }) => {
      const color = randomColor();
      players[socket.id] = { name, color };
      gameState.scores[socket.id] = 0;
      ns.emit("player_joined", { playerId: socket.id, playerName: name });
    });

    socket.on("start_shakeweight_game", ({ threshold }) => {
      gameState.active = true;
      gameState.threshold = threshold || 500;
      gameState.scores = {};
      for (const id in players) gameState.scores[id] = 0;

      ns.emit("game_started");

      let countdown = 3;
      gameState.countdownInterval = setInterval(() => {
        ns.emit("countdown", { time: countdown });
        countdown--;
        if (countdown < 0) {
          clearInterval(gameState.countdownInterval);
          ns.emit("countdown", { time: 0 });
        }
      }, 1000);
    });

    socket.on("jerk_update", ({ score }) => {
      if (!gameState.active || !players[socket.id]) return;
      gameState.scores[socket.id] = score;
      ns.emit("jerk_scores_update", { scores: gameState.scores });

      if (score >= gameState.threshold) {
        gameState.active = false;
        clearInterval(gameState.countdownInterval);
        ns.emit("game_ended", {
          winner: { id: socket.id, name: players[socket.id].name },
          finalScores: gameState.scores,
        });
      }
    });

    socket.on("reset_shakeweight_game", () => {
      gameState.active = false;
      gameState.scores = {};
      if (gameState.countdownInterval) clearInterval(gameState.countdownInterval);
      ns.emit("reset_game");
    });

    socket.on("disconnect", () => {
      if (!players[socket.id]) return;
      ns.emit("player_left", { playerId: socket.id });
      delete gameState.scores[socket.id];
      delete players[socket.id];
    });
  });
};

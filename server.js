console.log("SERVER FILE IS RUNNING");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const players = {}; // socket.id -> {name, color}

function getRandomColor() {
  return '#' + Math.floor(Math.random() * 16777215).toString(16);
}

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  socket.on("join", (data) => {
    const { name, game } = data;
    const color = getRandomColor();
    players[socket.id] = { name, color, game };
    console.log(`Player joined: ${name} (${socket.id}) with color ${color} for game ${game}`);

    io.emit("player_joined", { id: socket.id, name, color });
  });

  socket.on("imu", (data) => {
    console.log("IMU:", data);

    // later: send to Unity
    io.emit("imu_broadcast", {
      id: socket.id,
      data
    });
  });

  socket.on("jerk", (data) => {
    console.log("Jerk detected:", data);
    if (players[socket.id]) {
      players[socket.id].out = true;
      io.emit("player_out", { id: socket.id });
    }
    io.emit("jerk_broadcast", {
      id: socket.id,
      ...data
    });
  });

  socket.on("start_game", (game) => {
    console.log(`Starting game: ${game}`);
    io.emit("game_started");
  });

  socket.on("message", (text) => {
    console.log("Message:", text);
    io.emit("message", { id: socket.id, text });
  });

  socket.on("reset", () => {
    console.log("Resetting game");
    for (const id in players) {
      players[id].out = false;
    }
    io.emit("reset");
  });

  socket.on("disconnect", () => {
    if (players[socket.id]) {
      const { name, color } = players[socket.id];
      console.log(`Player left: ${name} (${socket.id})`);
      io.emit("player_left", { id: socket.id, name, color });
      delete players[socket.id];
    }
  });
});

server.listen(3000, () => {
  console.log("Server running on port 3000");
});
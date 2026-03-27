console.log("SERVER FILE IS RUNNING");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const players = {}; // socket.id -> {name, color, loads, loadMagnitudes}

// Game state
let gameState = 'lobby'; // 'lobby', 'countdown', 'playing', 'ended'
let gameTimer = null;
let countdownTimer = null;
let gameDuration = 10000; // 10 seconds default
let scores = {}; // socket.id -> {name, loads, avgMagnitude}

function getRandomColor() {
  return '#' + Math.floor(Math.random() * 16777215).toString(16);
}

function resetGame() {
  gameState = 'lobby';
  scores = {};
  for (const id in players) {
    players[id].loads = 0;
    players[id].loadMagnitudes = [];
  }
}

function startCountdown() {
  if (gameState !== 'lobby') return;
  
  gameState = 'countdown';
  let count = 3;
  
  io.emit('countdown', { count });
  console.log('Countdown started');
  
  countdownTimer = setInterval(() => {
    count--;
    if (count > 0) {
      io.emit('countdown', { count });
      console.log(`Countdown: ${count}`);
    } else {
      clearInterval(countdownTimer);
      startGame();
    }
  }, 1000);
}

function startGame() {
  gameState = 'playing';
  console.log('Game started!');
  io.emit('game_start', { duration: gameDuration });
  
  // Auto-end game after duration
  gameTimer = setTimeout(() => {
    endGame();
  }, gameDuration);
}

function endGame() {
  gameState = 'ended';
  clearTimeout(gameTimer);
  console.log('Game ended!');
  
  // Calculate final scores
  for (const id in players) {
    const loads = players[id].loads;
    const magnitudes = players[id].loadMagnitudes;
    const avgMagnitude = magnitudes.length > 0 
      ? magnitudes.reduce((a, b) => a + b, 0) / magnitudes.length 
      : 0;
    
    scores[id] = {
      name: players[id].name,
      color: players[id].color,
      loads,
      avgMagnitude: avgMagnitude.toFixed(2)
    };
  }
  
  // Sort by load count (descending)
  const sortedScores = Object.entries(scores)
    .sort((a, b) => b[1].loads - a[1].loads)
    .map(([id, score]) => ({ id, ...score }));
  
  // Find jerkiest (highest average magnitude)
  let jerkiest = null;
  let maxAvgMag = -1;
  for (const [id, score] of Object.entries(scores)) {
    if (parseFloat(score.avgMagnitude) > maxAvgMag) {
      maxAvgMag = parseFloat(score.avgMagnitude);
      jerkiest = { id, ...score };
    }
  }
  
  io.emit('game_ended', {
    scores: sortedScores,
    jerkiest
  });
}

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  socket.on("join", (data) => {
    const { name } = data;
    const color = getRandomColor();
    players[socket.id] = { name, color, loads: 0, loadMagnitudes: [] };
    console.log(`Player joined: ${name} (${socket.id}) with color ${color}`);

    io.emit("player_joined", { id: socket.id, name, color });
  });

  socket.on("imu", (data) => {
    // Optionally log IMU data
    io.emit("imu_broadcast", {
      id: socket.id,
      data
    });
  });

  socket.on("load", (data) => {
    // Track load (jerk) events
    console.log("Load detected:", data);
    if (players[socket.id] && gameState === 'playing') {
      players[socket.id].loads += 1;
      players[socket.id].loadMagnitudes.push(data.value);
      console.log(`${players[socket.id].name} - Loads: ${players[socket.id].loads}`);
    }
    io.emit("load_broadcast", {
      id: socket.id,
      name: players[socket.id]?.name,
      loads: players[socket.id]?.loads || 0
    });
  });

  socket.on("update_thresholds", (data) => {
    console.log("Updating thresholds:", data);
    io.emit("update_thresholds", data);
  });

  socket.on("start_game", () => {
    console.log("Start game requested");
    startCountdown();
  });

  socket.on("end_game", () => {
    console.log("End game requested");
    endGame();
  });

  socket.on("reset", () => {
    console.log("Resetting game");
    resetGame();
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
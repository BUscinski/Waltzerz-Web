console.log("SERVER FILE IS RUNNING");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const { OpenAI } = require('openai');
const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1'
});

const MODEL_NAME = 'llama-3.1-8b-instant';

app.use(express.static("public"));
app.use(express.json());

async function generatePrompt(seed) {
  const completion = await groq.chat.completions.create({
    model: MODEL_NAME,
    messages: [
      { role: 'system', content: 'You are a creative prompt generator for a party game like Quiplash. Generate a single short, funny, fill-in-the-blank or open-ended question. No explanation, just the prompt.' },
      { role: 'user', content: `Generate a Quiplash-style prompt using this theme: ${seed}` }
    ],
    max_tokens: 80,
    temperature: 0.9
  });

  const prompt = completion.choices?.[0]?.message?.content?.trim() || '';
  console.log('Groq result:', prompt);
  if (!prompt) throw new Error('Empty response from Groq');
  return prompt;
}

const players = {}; // socket.id -> {name, color}

// ShakeWeight game state
let shakeweightState = {
  active: false,
  threshold: 500,
  scores: {}, // socket.id -> jerk score
  startTime: null,
  countdownInterval: null
};

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

    // For ShakeWeight game, emit with playerId and playername
    if (game === 'shakeweight') {
      io.emit("player_joined", { playerId: socket.id, playerName: name });
      shakeweightState.scores[socket.id] = 0;
    } else {
      io.emit("player_joined", { id: socket.id, name, color });
    }
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

  socket.on("start_game", async (data) => {
    const { game, seed } = data;
    console.log(`Starting game: ${game} with seed: ${seed}`);

    // Tell clients game is starting, and they can show loading state
    io.emit("game_started");
    io.emit("prompt_loading");

    try {
      // Generate prompt from seed (await so we only send once available)
      const prompt = await generatePrompt(seed);
      console.log(`Generated prompt: ${prompt}`);

      // Broadcast the prompt when ready
      io.emit("prompt_generated", { prompt });
    } catch (error) {
      console.error('Prompt generation failed:', error);
      io.emit("prompt_error", { error: error.message || 'Prompt generation failed' });
    }
  });

  socket.on("message", (text) => {
    console.log("Message from", socket.id, ":", text);
    
    // Emit player response directly to host (no AI transformation)
    io.emit("player_response", { id: socket.id, text });
  });

  socket.on("reset", () => {
    console.log("Resetting game");
    for (const id in players) {
      players[id].out = false;
    }
    io.emit("reset");
  });

  socket.on("start_shakeweight_game", (data) => {
    const { threshold } = data;
    console.log(`Starting ShakeWeight game with threshold: ${threshold}`);
    
    shakeweightState.active = true;
    shakeweightState.threshold = threshold;
    shakeweightState.scores = {};
    
    // Initialize scores for all connected players
    for (const id in players) {
      if (players[id].game === 'shakeweight') {
        shakeweightState.scores[id] = 0;
      }
    }

    io.emit("game_started");

    // Start countdown: 3, 2, 1, GO!
    let countdown = 3;
    shakeweightState.countdownInterval = setInterval(() => {
      io.emit("countdown", { time: countdown });
      countdown--;

      if (countdown < 0) {
        clearInterval(shakeweightState.countdownInterval);
        io.emit("countdown", { time: 0 });
      }
    }, 1000);
  });

  socket.on("jerk_update", (data) => {
    const { score } = data;
    if (!shakeweightState.active || !players[socket.id]) return;

    shakeweightState.scores[socket.id] = score;

    // Emit updated scores to host
    io.emit("jerk_scores_update", { scores: shakeweightState.scores });

    // Check if anyone reached threshold
    if (score >= shakeweightState.threshold) {
      shakeweightState.active = false;
      clearInterval(shakeweightState.countdownInterval);

      const winnerName = players[socket.id].name;
      const winnerData = {
        id: socket.id,
        name: winnerName
      };

      io.emit("game_ended", {
        winner: winnerData,
        finalScores: shakeweightState.scores
      });

      // Tell all phone clients game ended
      io.emit("game_ended");
    }
  });

  socket.on("reset_shakeweight_game", () => {
    console.log("Resetting ShakeWeight game");
    shakeweightState.active = false;
    shakeweightState.scores = {};
    if (shakeweightState.countdownInterval) {
      clearInterval(shakeweightState.countdownInterval);
    }
    io.emit("reset_game");
  });

  socket.on("disconnect", () => {
    if (players[socket.id]) {
      const { name, color, game } = players[socket.id];
      console.log(`Player left: ${name} (${socket.id})`);
      
      if (game === 'shakeweight') {
        io.emit("player_left", { playerId: socket.id });
        delete shakeweightState.scores[socket.id];
      } else {
        io.emit("player_left", { id: socket.id, name, color });
      }
      
      delete players[socket.id];
    }
  });
});

server.listen(3000, () => {
  console.log("Server running on port 3000");
});
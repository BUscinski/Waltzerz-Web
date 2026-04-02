console.log("SERVER FILE IS RUNNING");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { HfInference } = require("@huggingface/inference");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const hf = new HfInference();

app.use(express.static("public"));

const players = {}; // socket.id -> {name, color}

function getRandomColor() {
  return '#' + Math.floor(Math.random() * 16777215).toString(16);
}

async function generatePrompt(seed) {
  try {
    const response = await hf.textGeneration({
      model: 'gpt2',
      inputs: `Generate a creative prompt based on these words: ${seed}. Keep it short and fun.`,
      parameters: { max_new_tokens: 50, temperature: 0.9 }
    });
    return response.generated_text.replace(/Generate a creative prompt.*?words: .*?\. Keep it short and fun\./, '').trim();
  } catch (error) {
    console.error('Hugging Face error:', error);
    return `Prompt based on: ${seed}`;
  }
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

  socket.on("start_game", async (data) => {
    const { game, seed } = data;
    console.log(`Starting game: ${game} with seed: ${seed}`);
    
    // Generate prompt from seed
    const prompt = await generatePrompt(seed);
    console.log(`Generated prompt: ${prompt}`);
    
    // Broadcast game start and prompt to all clients
    io.emit("game_started");
    io.emit("prompt_generated", { prompt });
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
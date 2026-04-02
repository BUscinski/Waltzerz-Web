console.log("SERVER FILE IS RUNNING");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { HfInference } = require("@huggingface/inference");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Use the new Hugging Face router endpoint (required by their updated API)
// Ensure HF_API_KEY is set in environment variables on Render.
const hf = new HfInference({
  apiKey: `Bearer ${process.env.HF_API_KEY}`,
  baseURL: 'https://router.huggingface.co'
});

// Pick model from environment variable (supports change without code edits)
// Set HF_MODEL in Render to one of:
//  - tiiuae/falcon-7b-instruct
//  - google/flan-t5-small
//  - bigcode/starcoder
//  - <another router-compatible model>
const MODEL_NAME = process.env.HF_MODEL || 'google/flan-t5-small';

app.use(express.static("public"));

const players = {}; // socket.id -> {name, color}

function getRandomColor() {
  return '#' + Math.floor(Math.random() * 16777215).toString(16);
}

async function generatePrompt(seed) {
  try {
    console.log('Using model:', MODEL_NAME);
    console.log('auth header looks like this: ', hf.apiKey);
    const response = await hf.textGeneration({
      model: MODEL_NAME,
      inputs: `Generate a creative prompt based on these words: ${seed}. Keep it short and fun.`,
      parameters: { max_new_tokens: 50, temperature: 0.9 }
    });
    console.log('Raw response:', response);

    // Handle multiple possible response formats
    const rawText =
      (typeof response === 'string' && response) ||
      response.generated_text ||
      (Array.isArray(response) && response[0]?.generated_text) ||
      '';

    const cleaned = rawText
      .replace(/^Generate a creative prompt based on these words:.*?\.\s*Keep it short and fun\./i, '')
      .trim();

    if (!cleaned) {
      throw new Error('Empty generated prompt');
    }

    console.log('Cleaned prompt:', cleaned);
    return cleaned;
  } catch (error) {
    console.error('Hugging Face error:', error);
    throw error;
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
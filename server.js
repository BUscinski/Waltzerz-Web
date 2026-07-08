console.log("SERVER FILE IS RUNNING");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));
app.use(express.json());

const { saveGame } = require("./db");

app.post("/api/save-game", (req, res) => {
  try {
    const { players, rounds } = req.body;
    const sessionId = saveGame(players, rounds);
    console.log(`Game saved — session ${sessionId}`);
    res.json({ ok: true, sessionId });
  } catch (e) {
    console.error("Save game error:", e);
    res.status(500).json({ error: "Failed to save game" });
  }
});

require("./games/busters")(io.of("/busters"));
require("./games/shakeweight")(io.of("/shakeweight"));
require("./games/waltzers")(io.of("/waltzers"));

server.listen(3000, () => console.log("Server running on port 3000"));

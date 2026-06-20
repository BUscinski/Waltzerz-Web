console.log("SERVER FILE IS RUNNING");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));
app.use(express.json());

require("./games/busters")(io.of("/busters"));
require("./games/shakeweight")(io.of("/shakeweight"));
require("./games/waltzers")(io.of("/waltzers"));

server.listen(3000, () => console.log("Server running on port 3000"));

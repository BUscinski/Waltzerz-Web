console.log("SERVER FILE IS RUNNING");


const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  socket.on("imu", (data) => {
    console.log("IMU:", data);

    // later: send to Unity
    io.emit("imu_broadcast", {
      id: socket.id,
      data
    });
  });
});

server.listen(3000, () => {
  console.log("Server running on port 3000");
});
const { io } = require("socket.io-client");
const socket = io("http://localhost:5001");

socket.on("connect", () => {
  console.log("Connected to relay with ID:", socket.id);
  socket.emit("join_relay", { nickname: "testUser", uid: "test1234", publicKeyBase64: "test" });
});

socket.on("active_users", (users) => {
  console.log("Active users received:", users);
  process.exit(0);
});

socket.on("connect_error", (err) => {
  console.log("Connection Error:", err.message);
  process.exit(1);
});

setTimeout(() => {
  console.log("Timeout connecting to socket");
  process.exit(1);
}, 3000);

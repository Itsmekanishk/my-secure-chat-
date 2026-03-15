import { io } from "socket.io-client";

// In production, this should point to your backend deployed URL
const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || "http://localhost:5001";

export const socket = io(BACKEND_URL, {
  autoConnect: false, // Don't connect until user logs in / initializes
});

console.log('Socket initialized with BACKEND_URL:', BACKEND_URL);

socket.on("connect_error", (err) => {
  console.log(`Socket connect_error due to ${err.message}`);
});

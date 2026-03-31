import express from "express";
import http from "http";
import mongoose from "mongoose";
import cors from "cors";
import dotenv from "dotenv";
import { Server } from "socket.io";

import matchRoutes from "./routes/matchRoutes.js";
import matchSocket from "./sockets/matchSockets.js";
import { declareInnings } from "./controllers/matchController.js";

dotenv.config();

const app = express();
const server = http.createServer(app);

/* ================== MIDDLEWARE ================== */
app.use(cors({ origin: "*", methods: ["GET", "POST"] }));
app.use(express.json());

/* ================== DATABASE ================== */
const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;

if (!mongoUri) {
  console.error(
    "Missing MongoDB URI. Set MONGO_URI or MONGODB_URI in environment variables."
  );
  process.exit(1);
}

mongoose
  .connect(mongoUri, { dbName: "gully-cricket" })
  .then(() => console.log("MongoDB connected"))
  .catch((err) => {
    console.error("MongoDB connection failed:", err.message);
    process.exit(1);
  });

/* ================== SOCKET.IO ================== */
const allowedOrigin = "*";

app.use(cors({
  origin: allowedOrigin,
  credentials: true
}));

const io = new Server(server, {
  cors: {
    origin: allowedOrigin,
    methods: ["GET", "POST"]
  }
});


matchSocket(io);

/* inject io BEFORE routes */
app.use((req, res, next) => {
  req.io = io;
  next();
});

/* ================== ROUTES ================== */
app.get("/", (req, res) => res.send("Gully Cricket API running"));
app.get("/api/healthz", (req, res) => {
  res.json({
    ok: true,
    service: "gully-cricket-api",
    now: new Date().toISOString()
  });
});
app.use("/api/match", matchRoutes);
app.use("/api/match/declare", declareInnings); 

/* ================== ERROR HANDLER ================== */
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: "Internal Server Error" });
});

/* ================== START SERVER ================== */
const PORT = process.env.PORT || 5000;
server.listen(PORT, () =>
  console.log(`Server running on port ${PORT}`)
);

/* ================== KEEP ALIVE (RENDER) ================== */
const SELF_PING_URL =
  process.env.RENDER_EXTERNAL_URL ||
  process.env.PUBLIC_BASE_URL ||
  null;

if (SELF_PING_URL) {
  const keepAliveUrl = `${String(SELF_PING_URL).replace(/\/+$/, "")}/api/healthz`;
  const KEEP_ALIVE_MS = 8 * 60 * 1000; // under Render free-tier idle window

  const pingSelf = async () => {
    try {
      await fetch(keepAliveUrl, { method: "GET" });
      console.log("Keep-alive ping sent:", keepAliveUrl);
    } catch (err) {
      console.error("Keep-alive ping failed:", err.message);
    }
  };

  setTimeout(() => {
    pingSelf();
    setInterval(pingSelf, KEEP_ALIVE_MS);
  }, 20 * 1000);
}

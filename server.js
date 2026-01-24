import express from "express";
import http from "http";
import mongoose from "mongoose";
import cors from "cors";
import dotenv from "dotenv";
import { Server } from "socket.io";

import matchRoutes from "./routes/matchRoutes.js";
import matchSocket from "./sockets/matchSockets.js";

dotenv.config();

const app = express();
const server = http.createServer(app);

/* ================== MIDDLEWARE ================== */
app.use(cors({ origin: "*", methods: ["GET", "POST"] }));
app.use(express.json());

/* ================== DATABASE ================== */
mongoose
  .connect(process.env.MONGO_URI, { dbName: "gully-cricket" })
  .then(() => console.log("MongoDB connected"))
  .catch((err) => {
    console.error(err);
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
app.use("/api/match", matchRoutes);

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

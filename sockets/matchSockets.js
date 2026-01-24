export default function matchSocket(io) {
  io.on("connection", (socket) => {
    console.log("Client connected:", socket.id);

    // Viewer or scorer joins match room
    socket.on("join-match", (matchId) => {
      socket.join(matchId);
      console.log(`Socket ${socket.id} joined match ${matchId}`);
    });

    socket.on("disconnect", () => {
      console.log("Client disconnected:", socket.id);
    });
  });
}

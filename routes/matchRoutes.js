import express from "express";

import {
  createMatch,
  verifyPin,
  setOpeners,
  selectBowler,
  addBall,
  editLastBall,
  addNextBatter,
  getMatch,
  getLiveMatches,
  declareInnings
} from "../controllers/matchController.js";

const router = express.Router();

/* ADMIN */
router.post("/create", createMatch);
router.post("/verify-pin", verifyPin);

/* UMPIRE */
router.post("/set-openers", setOpeners);
router.post("/select-bowler", selectBowler);
router.post("/add-ball", addBall);
router.post("/edit-last-ball", editLastBall);
router.post("/add-next-batter", addNextBatter);
router.post("/declare", declareInnings);

/* PUBLIC */
router.get("/live", getLiveMatches);
router.get("/:id", getMatch); // ✅ always last

export default router;

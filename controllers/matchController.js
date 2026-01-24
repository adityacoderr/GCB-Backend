import Match from "../models/Match.js";
import bcrypt from "bcrypt";

/* ================= CREATE MATCH ================= */
export const createMatch = async (req, res) => {
  try {
    const { oversLimit, teams, players, pin } = req.body;

    if (
      !oversLimit ||
      !teams ||
      teams.length !== 2 ||
      !players?.teamA ||
      !players?.teamB ||
      players.teamA.length < 2 ||
      players.teamB.length < 1 ||
      !pin
    ) {
      return res.status(400).json({ error: "Invalid match setup data" });
    }

    const pinHash = await bcrypt.hash(pin, 10);

    const normalizePlayer = (p) => ({
      name: p.name?.trim(),
      role: p.role || "BATTER",
      runs: 0,
      balls: 0,
      status: "YET_TO_BAT"
    });

    const squadA = players.teamA.map(normalizePlayer);
    const squadB = players.teamB.map(normalizePlayer);

    // Innings 1: Team A bats by default (can change later)
    const innings1 = {
      inningsNumber: 1,
      battingTeam: teams[0],
      bowlingTeam: teams[1],
      totalRuns: 0,
      wickets: 0,
      ballsBowled: 0,
      striker: null,
      nonStriker: null,
      currentBowler: null,
      lastBowler: null,
      players: squadA.map((p) => ({ ...p })), // batting scorecard snapshot
      ballsLog: []
    };

    const match = await Match.create({
      teams,
      oversLimit: Number(oversLimit),
      scorerPinHash: pinHash,
      currentInnings: 1,
      status: "LIVE",
      squads: { teamA: squadA, teamB: squadB },
      innings: [innings1]
    });

    res.json(match);
  } catch (err) {
    console.error("CREATE MATCH ERROR:", err);
    res.status(500).json({ error: err.message });
  }
};



/* ================= START MATCH (UMPIRE) ================= */
/*
Umpire selects:
- Batting team
- Two openers
- First bowler
*/
export const startMatch = async (req, res) => {
  try {
    const {
      matchId,
      battingTeam,
      striker,
      nonStriker,
      bowler
    } = req.body;

    const match = await Match.findById(matchId);
    if (!match) return res.status(404).json({ error: "Match not found" });

    if (match.status !== "SETUP") {
      return res.status(400).json({ error: "Match already started" });
    }

    const bowlingTeam =
      battingTeam === match.teams[0]
        ? match.teams[1]
        : match.teams[0];

    const battingPlayers =
      battingTeam === match.teams[0]
        ? match.teamAPlayers
        : match.teamBPlayers;

    if (
      !battingPlayers.includes(striker) ||
      !battingPlayers.includes(nonStriker)
    ) {
      return res.status(400).json({ error: "Invalid opener selection" });
    }

    match.status = "LIVE";

    match.innings.push({
      battingTeam,
      bowlingTeam,
      totalRuns: 0,
      wickets: 0,
      ballsBowled: 0,
      striker,
      nonStriker,
      currentBowler: bowler,
      players: battingPlayers.map((p) => ({
        name: p,
        runs: 0,
        balls: 0,
        status:
          p === striker || p === nonStriker
            ? "ON"
            : "YET_TO_BAT"
      })),
      ballsLog: []
    });

    await match.save();

    res.json(match);
  } catch (err) {
    console.error("START MATCH ERROR:", err);
    res.status(500).json({ error: err.message });
  }
};

/* ================= ADD BALL (CORE ENGINE) ================= */
export const addBall = async (req, res) => {
  try {
    const { matchId, type, runs = 0 } = req.body;

    const safeRuns = Number(runs) || 0;

    const match = await Match.findById(matchId);
    if (!match) return res.status(404).json({ error: "Match not found" });
    if (match.status !== "LIVE")
      return res.status(400).json({ error: "Match not live" });

    // ✅ Always re-resolve innings from match.currentInnings
    const currentInningsObj = match.innings[match.currentInnings - 1];
    if (!currentInningsObj)
      return res.status(400).json({ error: "Invalid innings state" });

    const innings = currentInningsObj;

    if (!innings.striker || !innings.nonStriker) {
      return res.status(400).json({ error: "Select batters first" });
    }

    if (!innings.currentBowler) {
      return res.status(400).json({ error: "Select bowler first" });
    }

    const legalBall = type === "RUN" || type === "WICKET";
    const maxBalls = match.oversLimit * 6;

    if (legalBall && innings.ballsBowled >= maxBalls) {
      return res.status(400).json({ error: "Overs completed" });
    }

    const over = Math.floor(innings.ballsBowled / 6) + 1;
    const ball = (innings.ballsBowled % 6) + 1;

    const striker = innings.players.find((p) => p.name === innings.striker);
    if (!striker) return res.status(400).json({ error: "Striker invalid" });

    // ✅ capture bowler BEFORE modifications
    const ballBowler = innings.currentBowler;

    /* ================= EXTRAS ================= */
    // Wide / NoBall => run count added, not legal ball
    if (type === "WIDE" || type === "NOBALL") {
      innings.totalRuns += safeRuns;

      innings.ballsLog.push({
        over,
        ball,
        type,
        runs: safeRuns,
        batter: striker.name,
        bowler: ballBowler
      });

      await match.save();
      req.io.to(match._id.toString()).emit("match-updated", match);
      return res.json(match);
    }

    /* ================= LEGAL BALL ================= */
    innings.totalRuns += safeRuns;

    striker.runs += safeRuns;
    striker.balls += 1;
    innings.ballsBowled += 1;

    /* ================= WICKET ================= */
    if (type === "WICKET") {
      innings.wickets += 1;
      striker.status = "OUT";
      // striker becomes null -> frontend selects next batter
      innings.striker = null;
    }

    /* ================= STRIKE ROTATION ================= */
    // Rotate strike only if NOT wicket (because striker is already OUT)
    if (type !== "WICKET" && safeRuns % 2 === 1) {
      [innings.striker, innings.nonStriker] = [
        innings.nonStriker,
        innings.striker
      ];
    }

    /* ================= LOG BALL ================= */
    innings.ballsLog.push({
      over,
      ball,
      type,
      runs: safeRuns,
      batter: striker.name,
      bowler: ballBowler
    });

    /* ================= OVER END ================= */
    const isEndOver = innings.ballsBowled % 6 === 0;
    if (isEndOver) {
      // swap strike at end of over only if both batters exist
      if (innings.striker && innings.nonStriker) {
        [innings.striker, innings.nonStriker] = [
          innings.nonStriker,
          innings.striker
        ];
      }

      innings.lastBowler = innings.currentBowler;
      innings.currentBowler = null; // force select bowler
    }

    /* ================= CHECK INNINGS END ================= */
    const inningsAllOut = innings.wickets >= innings.players.length - 1;
    const inningsOversDone = innings.ballsBowled >= maxBalls;

    const inningsEnded = inningsAllOut || inningsOversDone;

    // ✅ if second innings, also ends if chase complete
    const chaseDone =
      match.currentInnings === 2 &&
      match.target &&
      innings.totalRuns >= match.target;

    /* ================= TRANSITIONS ================= */
    if (match.currentInnings === 1 && inningsEnded) {
      // End of innings 1 -> start innings 2
      match.target = innings.totalRuns + 1;
      match.currentInnings = 2;

      const innings2BattingTeam = match.teams[1];
      const innings2BowlingTeam = match.teams[0];

      const innings2Players = (match.squads?.teamB || []).map((p) => ({
        name: p.name,
        role: p.role || "BATTER",
        runs: 0,
        balls: 0,
        status: "YET_TO_BAT"
      }));

      match.innings.push({
        inningsNumber: 2,
        battingTeam: innings2BattingTeam,
        bowlingTeam: innings2BowlingTeam,
        totalRuns: 0,
        wickets: 0,
        ballsBowled: 0,
        striker: null,
        nonStriker: null,
        currentBowler: null,
        lastBowler: null,
        players: innings2Players,
        ballsLog: []
      });
    }

    // ✅ second innings completion check after transition logic
    if (match.currentInnings === 2) {
      const innings2 = match.innings[1]; // now safe reference

      if (innings2) {
        const innings2AllOut = innings2.wickets >= innings2.players.length - 1;
        const innings2OversDone = innings2.ballsBowled >= maxBalls;
        const innings2ChaseDone =
          match.target && innings2.totalRuns >= match.target;

        if (innings2AllOut || innings2OversDone || innings2ChaseDone) {
          match.status = "COMPLETED";
        }
      }
    }

    await match.save();
    req.io.to(match._id.toString()).emit("match-updated", match);

    res.json(match);
  } catch (err) {
    console.error("ADD BALL ERROR:", err);
    res.status(500).json({ error: err.message });
  }
};





/* ================= ADD NEXT BATTER ================= */
export const addNextBatter = async (req, res) => {
  try {
    const { matchId, name } = req.body;

    if (!matchId || !name) {
      return res.status(400).json({ error: "matchId and name required" });
    }

    const match = await Match.findById(matchId);
    if (!match) return res.status(404).json({ error: "Match not found" });

    const innings = match.innings[match.currentInnings - 1];

    const batter = innings.players.find((p) => p.name === name);
    if (!batter) return res.status(400).json({ error: "Batter not found" });

    if (batter.status !== "YET_TO_BAT") {
      return res.status(400).json({ error: "Batter already used" });
    }

    batter.status = "ON";
    innings.striker = batter.name;

    await match.save();
    req.io.to(match._id.toString()).emit("match-updated", match);

    res.json(match);
  } catch (err) {
    console.error("ADD NEXT BATTER ERROR:", err);
    res.status(500).json({ error: err.message });
  }
};


/* ================= GET LIVE MATCHES ================= */
export const getLiveMatches = async (req, res) => {
  try {
    const matches = await Match.find(
      {
        status: { $in: ["SETUP", "LIVE", "COMPLETED", "Completed", "completed"] }
      },
      {
        teams: 1,
        oversLimit: 1,
        currentInnings: 1,
        target: 1,
        status: 1,
        innings: 1,
        createdAt: 1
      }
    ).sort({ createdAt: -1 });

    res.json(matches);
  } catch (err) {
    console.error("GET MATCHES ERROR:", err);
    res.status(500).json({ error: err.message });
  }
};




/* ================= GET MATCH ================= */
export const getMatch = async (req, res) => {
  try {
    const match = await Match.findById(req.params.id);
    if (!match) return res.status(404).json({ error: "Match not found" });

    res.json(match);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/* ================= VERIFY PIN ================= */
export const verifyPin = async (req, res) => {
  try {
    const { matchId, pin } = req.body;

    if (!matchId || !pin) {
      return res.status(400).json({ error: "Missing data" });
    }

    const match = await Match.findById(matchId);
    if (!match) {
      return res.status(404).json({ error: "Match not found" });
    }

    if (!match.scorerPinHash) {
      console.error("PIN HASH MISSING FOR MATCH:", matchId);
      return res.status(500).json({
        error: "PIN not configured for this match"
      });
    }

    const ok = await bcrypt.compare(
      String(pin),
      match.scorerPinHash
    );

    if (!ok) {
      return res.status(401).json({ error: "Invalid PIN" });
    }

    res.json({ success: true });
  } catch (err) {
    console.error("VERIFY PIN ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
};


export const setOpeners = async (req, res) => {
  try {
    const { matchId, striker, nonStriker } = req.body;

    if (!matchId || !striker || !nonStriker || striker === nonStriker) {
      return res.status(400).json({ error: "Invalid opener selection" });
    }

    const match = await Match.findById(matchId);
    if (!match) return res.status(404).json({ error: "Match not found" });

    if (match.status !== "LIVE") {
      return res.status(400).json({ error: "Match not live" });
    }

    const innings = match.innings[match.currentInnings - 1];

    const p1 = innings.players.find((p) => p.name === striker);
    const p2 = innings.players.find((p) => p.name === nonStriker);

    if (!p1 || !p2) {
      return res.status(400).json({ error: "Batter not found" });
    }

    if (p1.status !== "YET_TO_BAT" || p2.status !== "YET_TO_BAT") {
      return res.status(400).json({ error: "Batter already used" });
    }

    p1.status = "ON";
    p2.status = "ON";

    innings.striker = striker;
    innings.nonStriker = nonStriker;

    await match.save();
    req.io.to(match._id.toString()).emit("match-updated", match);

    res.json(match);
  } catch (err) {
    console.error("SET OPENERS ERROR:", err);
    res.status(500).json({ error: err.message });
  }
};


export const selectBowler = async (req, res) => {
  try {
    const { matchId, name } = req.body;

    if (!matchId || !name) {
      return res.status(400).json({ error: "matchId and name required" });
    }

    const match = await Match.findById(matchId);
    if (!match) return res.status(404).json({ error: "Match not found" });

    if (match.status !== "LIVE") {
      return res.status(400).json({ error: "Match not live" });
    }

    const innings = match.innings[match.currentInnings - 1];

    // ✅ determine bowling squad based on innings.bowlingTeam
    const bowlingSquad =
      innings.bowlingTeam === match.teams[0]
        ? match.squads.teamA
        : match.squads.teamB;

    const bowler = bowlingSquad.find((p) => p.name === name);
    if (!bowler) {
      return res.status(400).json({ error: "Bowler not in bowling squad" });
    }

    if (innings.lastBowler && innings.lastBowler === name) {
      return res
        .status(400)
        .json({ error: "Same bowler cannot bowl consecutive over" });
    }

    innings.currentBowler = name;

    await match.save();
    req.io.to(match._id.toString()).emit("match-updated", match);

    res.json(match);
  } catch (err) {
    console.error("SELECT BOWLER ERROR:", err);
    res.status(500).json({ error: err.message });
  }
};


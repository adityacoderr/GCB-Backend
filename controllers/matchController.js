import Match from "../models/Match.js";
import bcrypt from "bcrypt";

/* ================= CREATE MATCH ================= */
export const createMatch = async (req, res) => {
  try {
    const { oversLimit, teams, players, pin, format, toss, scheduledAt } = req.body;
    const teamAPlayersRaw = Array.isArray(players?.teamA) ? players.teamA : [];
    const teamBPlayersRaw = Array.isArray(players?.teamB) ? players.teamB : [];
    const hasSquadsNow =
      teamAPlayersRaw.length > 0 || teamBPlayersRaw.length > 0;

    const cleanTeams = (teams || []).map((t) => String(t || "").trim());

    if (
      !oversLimit ||
      cleanTeams.length !== 2 ||
      !cleanTeams[0] ||
      !cleanTeams[1] ||
      cleanTeams[0] === cleanTeams[1] ||
      !pin
    ) {
      return res.status(400).json({ error: "Invalid match setup data" });
    }

    if (hasSquadsNow && (teamAPlayersRaw.length < 2 || teamBPlayersRaw.length < 2)) {
      return res.status(400).json({
        error: "Add at least 2 players in each squad"
      });
    }

    if (teamAPlayersRaw.length !== teamBPlayersRaw.length) {
      return res.status(400).json({
        error: "Both teams must have equal number of players"
      });
    }

    if (!format || !["TEST", "ODI"].includes(format)) {
      return res.status(400).json({ error: "Invalid match format" });
    }

    const hasToss = Boolean(toss?.winner && toss?.decision);
    if (
      hasToss &&
      (!cleanTeams.includes(toss.winner) || !["BAT", "BOWL"].includes(toss.decision))
    ) {
      return res.status(400).json({ error: "Invalid toss data" });
    }
    if (hasToss && !hasSquadsNow) {
      return res.status(400).json({
        error: "Add squads when toss is set during match creation"
      });
    }

    const maxInningsPerTeam = format === "TEST" ? 2 : 1;
    const parsedScheduledAt = scheduledAt ? new Date(scheduledAt) : null;
    const hasValidSchedule =
      parsedScheduledAt && !Number.isNaN(parsedScheduledAt.getTime());
    const initialStatus =
      hasValidSchedule && parsedScheduledAt > new Date() ? "SETUP" : "LIVE";

    const pinHash = await bcrypt.hash(pin, 10);

    const normalizePlayer = (p) => ({
      name: p.name?.trim(),
      role: p.role || "BATTER",
      runs: 0,
      balls: 0,
      status: "YET_TO_BAT"
    });

    const squadA = teamAPlayersRaw
      .map(normalizePlayer)
      .filter((p) => p.name);
    const squadB = teamBPlayersRaw
      .map(normalizePlayer)
      .filter((p) => p.name);

    const tossWinner = hasToss ? toss.winner : null;
    const otherTeam =
      tossWinner === cleanTeams[0] ? cleanTeams[1] : cleanTeams[0];

    const firstBattingTeam =
      hasToss && toss.decision === "BAT" ? tossWinner : hasToss ? otherTeam : null;

    const firstBowlingTeam =
      hasToss
        ? firstBattingTeam === cleanTeams[0]
          ? cleanTeams[1]
          : cleanTeams[0]
        : null;

    const innings1 = {
      inningsNumber: 1,
      battingTeam: firstBattingTeam,
      bowlingTeam: firstBowlingTeam,
      totalRuns: 0,
      wickets: 0,
      ballsBowled: 0,
      isFreeHit: false,
      isDeclared: false,
      striker: null,
      nonStriker: null,
      currentBowler: null,
      lastBowler: null,
      players:
        !firstBattingTeam
          ? []
          : firstBattingTeam === cleanTeams[0]
          ? squadA.map((p) => ({ ...p }))
          : squadB.map((p) => ({ ...p })),
      ballsLog: []
    };

    const match = await Match.create({
      teams: cleanTeams,
      toss: {
        winner: tossWinner,
        decision: hasToss ? toss.decision : null
      },
      format,
      maxInningsPerTeam,
      declaredInnings: [],
      oversLimit: Number(oversLimit),
      scheduledAt: hasValidSchedule ? parsedScheduledAt : null,
      scorerPinHash: pinHash,
      currentInnings: 1,
      status: hasToss ? initialStatus : "SETUP",
      squads: { teamA: squadA, teamB: squadB },
      innings: [innings1]
    });

    res.json(match);
  } catch (err) {
    console.error("CREATE MATCH ERROR:", err);
    res.status(500).json({ error: err.message });
  }
};

/* ================= SET TOSS (SETUP -> LIVE) ================= */
export const setToss = async (req, res) => {
  try {
    const { matchId, winner, decision, players } = req.body;

    if (!matchId || !winner || !decision) {
      return res.status(400).json({ error: "matchId, winner and decision are required" });
    }

    if (!["BAT", "BOWL"].includes(decision)) {
      return res.status(400).json({ error: "Invalid toss decision" });
    }

    const match = await Match.findById(matchId);
    if (!match) return res.status(404).json({ error: "Match not found" });
    if (!match.teams.includes(winner)) {
      return res.status(400).json({ error: "Toss winner must be one of the match teams" });
    }
    if (match.status === "COMPLETED") {
      return res.status(400).json({ error: "Cannot set toss for completed match" });
    }

    const innings = match.innings?.[0];
    if (!innings) return res.status(400).json({ error: "Invalid innings state" });
    if (innings.ballsLog?.length > 0 || innings.ballsBowled > 0 || innings.totalRuns > 0) {
      return res.status(400).json({ error: "Cannot set toss after scoring has started" });
    }

    const hasTeamASquad = (match.squads?.teamA || []).length > 0;
    const hasTeamBSquad = (match.squads?.teamB || []).length > 0;
    const needsSquadsFromRequest = !hasTeamASquad || !hasTeamBSquad;

    if (needsSquadsFromRequest) {
      const rawTeamA = Array.isArray(players?.teamA) ? players.teamA : [];
      const rawTeamB = Array.isArray(players?.teamB) ? players.teamB : [];

      if (rawTeamA.length < 2 || rawTeamB.length < 2) {
        return res.status(400).json({
          error: "Add at least 2 players in each squad before toss"
        });
      }

      if (rawTeamA.length !== rawTeamB.length) {
        return res.status(400).json({
          error: "Both teams must have equal number of players"
        });
      }

      const normalizePlayer = (p) => ({
        name: String(p?.name || "").trim(),
        role: p?.role || "BATTER",
        runs: 0,
        balls: 0,
        status: "YET_TO_BAT"
      });

      const teamASquad = rawTeamA.map(normalizePlayer).filter((p) => p.name);
      const teamBSquad = rawTeamB.map(normalizePlayer).filter((p) => p.name);

      if (teamASquad.length < 2 || teamBSquad.length < 2) {
        return res.status(400).json({
          error: "Player names are required in both squads"
        });
      }

      match.squads = {
        teamA: teamASquad,
        teamB: teamBSquad
      };
    }

    const otherTeam = winner === match.teams[0] ? match.teams[1] : match.teams[0];
    const battingTeam = decision === "BAT" ? winner : otherTeam;
    const bowlingTeam = battingTeam === match.teams[0] ? match.teams[1] : match.teams[0];

    const squadSource = battingTeam === match.teams[0] ? match.squads.teamA : match.squads.teamB;
    if (!squadSource?.length) {
      return res.status(400).json({ error: "Batting squad is missing for toss start" });
    }
    const playersCopy = (squadSource || []).map((p) => ({
      name: p.name,
      role: p.role || "BATTER",
      runs: 0,
      balls: 0,
      status: "YET_TO_BAT"
    }));

    innings.battingTeam = battingTeam;
    innings.bowlingTeam = bowlingTeam;
    innings.players = playersCopy;
    innings.striker = null;
    innings.nonStriker = null;
    innings.currentBowler = null;
    innings.lastBowler = null;
    innings.totalRuns = 0;
    innings.wickets = 0;
    innings.ballsBowled = 0;
    innings.ballsLog = [];

    match.toss = { winner, decision };
    match.status = "LIVE";

    await match.save();
    req.io.to(match._id.toString()).emit("match-updated", match);
    res.json(match);
  } catch (err) {
    console.error("SET TOSS ERROR:", err);
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
      isFreeHit: false,
      isDeclared: false,
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

function startNextInnings(match) {
  const lastInnings = match.innings[match.innings.length - 1];

  const isTeamA = lastInnings.battingTeam === match.teams[0];

  const nextBattingTeam = isTeamA
    ? match.teams[1]
    : match.teams[0];

  const nextBowlingTeam = isTeamA
    ? match.teams[0]
    : match.teams[1];

  startSpecificInnings(match, nextBattingTeam, nextBowlingTeam);
}

function startSpecificInnings(match, battingTeam, bowlingTeam) {

  const squadSource =
    battingTeam === match.teams[0]
      ? match.squads.teamA
      : match.squads.teamB;

  const playersCopy = squadSource.map((p) => ({
    name: p.name,
    role: p.role,
    runs: 0,
    balls: 0,
    status: "YET_TO_BAT"
  }));

  match.currentInnings = match.innings.length + 1;

  match.innings.push({
    inningsNumber: match.currentInnings,
    battingTeam,
    bowlingTeam,
    totalRuns: 0,
    wickets: 0,
    ballsBowled: 0,
    isFreeHit: false,
    isDeclared: false,
    striker: null,
    nonStriker: null,
    currentBowler: null,
    lastBowler: null,
    players: playersCopy,
    ballsLog: []
  });
}

function completeMatch(match) {

  const teamA = match.teams[0];
  const teamB = match.teams[1];

  const teamATotal = match.innings
    .filter(i => i.battingTeam === teamA)
    .reduce((s, i) => s + i.totalRuns, 0);

  const teamBTotal = match.innings
    .filter(i => i.battingTeam === teamB)
    .reduce((s, i) => s + i.totalRuns, 0);

  match.status = "COMPLETED";

  // ===== ODI 2nd innings wickets win =====
  if (match.format === "ODI") {

    const lastInnings = match.innings[1];

    if (match.target && lastInnings.totalRuns >= match.target) {

      const wicketsLeft =
        lastInnings.players.length - 1 - lastInnings.wickets;

      match.result = `${lastInnings.battingTeam} won by ${wicketsLeft} wickets`;
      return;
    }
  }

  // ===== TEST innings victory =====
  if (match.format === "TEST") {

    if (match.innings.length === 3 && match.followOn) {

      const first = match.innings[0];

      match.result = `${first.battingTeam} won by an innings`;
      return;
    }

    // ===== TEST 4th innings chase win by wickets =====
    if (match.innings.length === 4) {
      const lastInnings = match.innings[3];

      if (match.target && lastInnings.totalRuns >= match.target) {
        const wicketsLeft =
          lastInnings.players.length - 1 - lastInnings.wickets;

        match.result = `${lastInnings.battingTeam} won by ${wicketsLeft} wickets`;
        return;
      }
    }
  }

  // ===== Normal run win =====
  if (teamATotal > teamBTotal)
    match.result = `${teamA} won by ${teamATotal - teamBTotal} runs`;
  else if (teamBTotal > teamATotal)
    match.result = `${teamB} won by ${teamBTotal - teamATotal} runs`;
  else
    match.result = "Match Drawn";
}

function recomputeFreeHit(innings) {
  let freeHit = false;

  for (const b of innings.ballsLog || []) {
    if (b.type === "NOBALL") {
      freeHit = true;
      continue;
    }

    if (b.type === "RUN" || b.type === "WICKET" || b.type === "RUNOUT") {
      freeHit = false;
    }
  }

  innings.isFreeHit = freeHit;
}

function isRunOutBall(ball) {
  return (
    ball?.type === "RUNOUT" ||
    (ball?.type === "WICKET" && ball?.dismissalType === "RUNOUT")
  );
}

function setTestTargetForFourthInnings(match) {
  if (match.format !== "TEST" || match.innings.length < 4) return;

  const teamA = match.teams[0];
  const teamB = match.teams[1];

  const teamATotal = match.innings
    .filter((i) => i.battingTeam === teamA)
    .reduce((sum, i) => sum + Number(i.totalRuns || 0), 0);

  const teamBTotal = match.innings
    .filter((i) => i.battingTeam === teamB)
    .reduce((sum, i) => sum + Number(i.totalRuns || 0), 0);

  match.target = Math.abs(teamATotal - teamBTotal) + 1;
}

function completeMatchIfTargetChased(match) {
  if (match.status !== "LIVE") return false;

  if (match.format === "ODI" && match.currentInnings === 2 && match.target) {
    const innings = match.innings[1];
    if (innings && innings.totalRuns >= match.target) {
      completeMatch(match);
      return true;
    }
  }

  if (match.format === "TEST" && match.currentInnings === 4) {
    const innings = match.innings[3];
    if (!innings) return false;

    const battingTeam = innings.battingTeam;
    const bowlingTeam = innings.bowlingTeam;

    const battingTotal = match.innings
      .filter((i) => i.battingTeam === battingTeam)
      .reduce((sum, i) => sum + Number(i.totalRuns || 0), 0);

    const bowlingTotal = match.innings
      .filter((i) => i.battingTeam === bowlingTeam)
      .reduce((sum, i) => sum + Number(i.totalRuns || 0), 0);

    // Optional safety: keep target aligned with aggregate state.
    if (!match.target) {
      match.target = Math.max(bowlingTotal - (battingTotal - innings.totalRuns), 0) + 1;
    }

    if (battingTotal > bowlingTotal) {
      completeMatch(match);
      return true;
    }
  }

  return false;
}
/* ================= ADD BALL (CORE ENGINE) ================= */
export const addBall = async (req, res) => {
  try {
    const { matchId, type, runs = 0, outBatter } = req.body;
    const normalizedType = String(type || "")
      .toUpperCase()
      .replace(/[\s_-]/g, "");

    const safeRuns = Number(runs) || 0;

    const match = await Match.findById(matchId);
    if (!match) return res.status(404).json({ error: "Match not found" });
    if (match.status !== "LIVE")
      return res.status(400).json({ error: "Match not live" });

    const innings = match.innings[match.currentInnings - 1];
    if (!innings)
      return res.status(400).json({ error: "Invalid innings state" });

    if (!innings.striker || !innings.nonStriker)
      return res.status(400).json({ error: "Select batters first" });

    if (!innings.currentBowler)
      return res.status(400).json({ error: "Select bowler first" });

    const legalBall =
      normalizedType === "RUN" ||
      normalizedType === "WICKET" ||
      normalizedType === "RUNOUT";
    const maxBalls = match.oversLimit * 6;

    if (legalBall && innings.ballsBowled >= maxBalls)
      return res.status(400).json({ error: "Overs completed" });

    const over = Math.floor(innings.ballsBowled / 6) + 1;
    const ball = (innings.ballsBowled % 6) + 1;

    const striker = innings.players.find(
      (p) => p.name === innings.striker
    );
    if (!striker)
      return res.status(400).json({ error: "Striker invalid" });

    const ballBowler = innings.currentBowler;

    /* ================= EXTRAS ================= */
    if (normalizedType === "WIDE" || normalizedType === "NOBALL") {
      innings.totalRuns += safeRuns;

      if (normalizedType === "NOBALL") {
        innings.isFreeHit = true;
      }

      innings.ballsLog.push({
        over,
        ball,
        type: normalizedType,
        runs: safeRuns,
        batter: striker.name,
        bowler: ballBowler
      });

      if (completeMatchIfTargetChased(match)) {
        await match.save();
        req.io.to(match._id.toString()).emit("match-updated", match);
        return res.json(match);
      }

      await match.save();
      req.io.to(match._id.toString()).emit("match-updated", match);
      return res.json(match);
    }

    /* ================= LEGAL BALL ================= */
    const isFreeHitBall = Boolean(innings.isFreeHit);
    const isRunOut = normalizedType === "RUNOUT";
    const wicketAllowed =
      isRunOut || (normalizedType === "WICKET" && !isFreeHitBall);
    const loggedType = wicketAllowed ? "WICKET" : "RUN";

    innings.totalRuns += safeRuns;
    striker.runs += safeRuns;
    striker.balls += 1;
    innings.ballsBowled += 1;
    innings.isFreeHit = false;

    let dismissedNameForLog = null;
    if (wicketAllowed) {
      const dismissedName = isRunOut
        ? outBatter || innings.striker
        : innings.striker;
      dismissedNameForLog = dismissedName;

      const dismissedPlayer = innings.players.find(
        (p) => p.name === dismissedName
      );

      if (!dismissedPlayer) {
        return res.status(400).json({ error: "Dismissed batter not found" });
      }

      if (
        dismissedName !== innings.striker &&
        dismissedName !== innings.nonStriker
      ) {
        return res.status(400).json({
          error: "Run out batter must be striker or non-striker"
        });
      }

      innings.wickets += 1;
      dismissedPlayer.status = "OUT";

      if (dismissedName === innings.striker) {
        innings.striker = null;
      } else {
        innings.nonStriker = null;
      }
    }

    if (!wicketAllowed && safeRuns % 2 === 1) {
      [innings.striker, innings.nonStriker] = [
        innings.nonStriker,
        innings.striker
      ];
    }

    innings.ballsLog.push({
      over,
      ball,
      type: loggedType,
      runs: safeRuns,
      batter: striker.name,
      bowler: ballBowler,
      dismissedPlayer: isRunOut ? dismissedNameForLog : undefined,
      dismissalType: isRunOut ? "RUNOUT" : null
    });

    if (completeMatchIfTargetChased(match)) {
      await match.save();
      req.io.to(match._id.toString()).emit("match-updated", match);
      return res.json(match);
    }

    const isEndOver = innings.ballsBowled % 6 === 0;

    if (isEndOver) {
      if (innings.striker && innings.nonStriker) {
        [innings.striker, innings.nonStriker] = [
          innings.nonStriker,
          innings.striker
        ];
      }

      innings.lastBowler = innings.currentBowler;
      innings.currentBowler = null;
    }

    /* ================= INNINGS END CHECK ================= */

    const inningsAllOut =
      innings.wickets >= innings.players.length - 1;

    const inningsOversDone =
      innings.ballsBowled >= maxBalls;

    const inningsEnded =
      inningsAllOut || inningsOversDone;

    if (inningsEnded) {

      const totalInningsPlayed = match.innings.length;
      const totalAllowedInnings =
        match.maxInningsPerTeam * 2;

      /* ================= ODI ================= */
      if (match.format === "ODI") {

        if (totalInningsPlayed === 1) {
          match.target = innings.totalRuns + 1;
        }

        if (totalInningsPlayed < totalAllowedInnings) {
          startNextInnings(match);
        } else {
          completeMatch(match);
        }
      }

      /* ================= TEST ================= */
      if (match.format === "TEST") {

  const inningsCount = match.innings.length;

  // AFTER 2 INNINGS → FOLLOW ON CHECK
  if (inningsCount === 2) {

    const first = match.innings[0];
    const second = match.innings[1];

    const lead = first.totalRuns - second.totalRuns;

    if (lead >= 100) {
      match.followOn = true;

      startSpecificInnings(
        match,
        second.battingTeam,
        second.bowlingTeam
      );

      await match.save();
      req.io.to(match._id.toString()).emit("match-updated", match);
      return res.json(match);
    }
  }
  if (match.format === "TEST" && match.innings.length === 4 && match.target && innings.totalRuns >= match.target) {
    completeMatch(match);
  }

  // AFTER 3 INNINGS → SET TARGET FOR 4TH
  if (inningsCount === 3) {

    const teamATotal = match.innings
      .filter(i => i.battingTeam === match.teams[0])
      .reduce((s, i) => s + i.totalRuns, 0);

    const teamBTotal = match.innings
      .filter(i => i.battingTeam === match.teams[1])
      .reduce((s, i) => s + i.totalRuns, 0);

    match.target = Math.abs(teamATotal - teamBTotal) + 1;
  }

  // DURING 4TH INNINGS → CHASE CHECK
  if (inningsCount === 4) {

    const chasing = match.innings[3];

    if (match.target && chasing.totalRuns >= match.target) {
      completeMatch(match);
      await match.save();
      req.io.to(match._id.toString()).emit("match-updated", match);
      return res.json(match);
    }
  }

  if (inningsCount < match.maxInningsPerTeam * 2) {
    startNextInnings(match);
  } else {
    completeMatch(match);
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

/* ================= EDIT LAST BALL ================= */
export const editLastBall = async (req, res) => {
  try {
    const { matchId, type, runs, dismissedPlayer } = req.body;

    const correctedType = String(type || "")
      .toUpperCase()
      .replace(/[\s_-]/g, "");
    const correctedRuns = Number(runs);

    if (
      !matchId ||
      !["RUN", "WIDE", "NOBALL", "WICKET", "RUNOUT"].includes(correctedType) ||
      Number.isNaN(correctedRuns) ||
      correctedRuns < 0
    ) {
      return res.status(400).json({ error: "Invalid edit payload" });
    }

    const match = await Match.findById(matchId);
    if (!match) return res.status(404).json({ error: "Match not found" });
    if (match.status !== "LIVE") {
      return res.status(400).json({ error: "Match not live" });
    }

    const innings = match.innings[match.currentInnings - 1];
    if (!innings) {
      return res.status(400).json({ error: "Invalid innings state" });
    }

    if (!innings.ballsLog?.length) {
      return res.status(400).json({ error: "No ball to edit" });
    }

    const lastBall = innings.ballsLog[innings.ballsLog.length - 1];
    if (!lastBall) {
      return res.status(400).json({ error: "No ball to edit" });
    }

    const oldType = lastBall.type;
    const oldRuns = Number(lastBall.runs || 0);
    const oldBatterName = lastBall.batter;
    const oldDismissedName =
      isRunOutBall(lastBall)
        ? lastBall.dismissedPlayer || lastBall.batter
        : lastBall.batter;
    const oldBowlerName = lastBall.bowler || innings.currentBowler || null;
    const isOldLegal =
      oldType === "RUN" || oldType === "WICKET" || oldType === "RUNOUT";
    const oldEndedOver = isOldLegal ? innings.ballsBowled % 6 === 0 : false;

    const oldBatter = innings.players.find((p) => p.name === oldBatterName);
    if (!oldBatter) {
      return res.status(400).json({ error: "Batter not found for last ball" });
    }

    // STEP 1: Revert old last-ball effect to get pre-ball state.
    innings.totalRuns -= oldRuns;

    if (isOldLegal) {
      innings.ballsBowled = Math.max(innings.ballsBowled - 1, 0);
      oldBatter.balls = Math.max(Number(oldBatter.balls || 0) - 1, 0);

      if (oldType === "RUN") {
        oldBatter.runs = Math.max(Number(oldBatter.runs || 0) - oldRuns, 0);
      }

      if (oldType === "WICKET" || oldType === "RUNOUT") {
        innings.wickets = Math.max(Number(innings.wickets || 0) - 1, 0);
        const oldDismissedPlayer = innings.players.find(
          (p) => p.name === oldDismissedName
        );
        if (!oldDismissedPlayer) {
          return res.status(400).json({
            error: "Old dismissed batter not found for edit"
          });
        }
        oldDismissedPlayer.status = "ON";

        // If a replacement batter was selected after dismissal, revert it.
        const revertReplacementAtEnd = (end) => {
          const currentName =
            end === "STRIKER" ? innings.striker : innings.nonStriker;

          if (currentName && currentName !== oldDismissedName) {
            const replacement = innings.players.find(
              (p) => p.name === currentName
            );
            if (
              replacement &&
              replacement.status === "ON" &&
              Number(replacement.runs || 0) === 0 &&
              Number(replacement.balls || 0) === 0
            ) {
              replacement.status = "YET_TO_BAT";
            }
          }

          if (end === "STRIKER") {
            innings.striker = oldDismissedName;
          } else {
            innings.nonStriker = oldDismissedName;
          }
        };

        if (oldDismissedName === oldBatterName) {
          revertReplacementAtEnd("STRIKER");
        } else {
          revertReplacementAtEnd("NON_STRIKER");
        }
      } else {
        // Undo net strike swap from old RUN.
        const oldNetSwap = (oldRuns % 2 === 1) !== oldEndedOver;
        if (oldNetSwap && innings.striker && innings.nonStriker) {
          [innings.striker, innings.nonStriker] = [
            innings.nonStriker,
            innings.striker
          ];
        }
      }

      if (oldEndedOver) {
        innings.currentBowler = oldBowlerName;
        if (innings.lastBowler === oldBowlerName) {
          innings.lastBowler = null;
        }
      }
    }

    // STEP 2: Apply corrected last-ball effect.
    const isNewLegal =
      correctedType === "RUN" ||
      correctedType === "WICKET" ||
      correctedType === "RUNOUT";
    innings.totalRuns += correctedRuns;

    const striker = innings.players.find((p) => p.name === innings.striker);

    if (isNewLegal) {
      if (!striker) {
        return res.status(400).json({ error: "No striker found to apply edit" });
      }

      striker.balls += 1;
      innings.ballsBowled += 1;

      if (correctedType === "RUN") {
        striker.runs += correctedRuns;
      } else {
        const dismissedName =
          correctedType === "RUNOUT"
            ? dismissedPlayer ||
              lastBall.dismissedPlayer ||
              innings.striker
            : innings.striker;

        if (
          dismissedName !== innings.striker &&
          dismissedName !== innings.nonStriker
        ) {
          return res.status(400).json({
            error: "Run out batter must be striker or non-striker"
          });
        }

        const dismissed = innings.players.find((p) => p.name === dismissedName);
        if (!dismissed) {
          return res.status(400).json({
            error: "Dismissed batter not found"
          });
        }

        innings.wickets += 1;
        dismissed.status = "OUT";
        if (dismissedName === innings.striker) {
          innings.striker = null;
        } else {
          innings.nonStriker = null;
        }
      }

      if (
        correctedType !== "WICKET" &&
        correctedType !== "RUNOUT" &&
        correctedRuns % 2 === 1
      ) {
        [innings.striker, innings.nonStriker] = [
          innings.nonStriker,
          innings.striker
        ];
      }

      const newEndedOver = innings.ballsBowled % 6 === 0;
      if (newEndedOver) {
        if (innings.striker && innings.nonStriker) {
          [innings.striker, innings.nonStriker] = [
            innings.nonStriker,
            innings.striker
          ];
        }
        innings.lastBowler = innings.currentBowler || oldBowlerName;
        innings.currentBowler = null;
      }
    }

    lastBall.type = correctedType === "RUNOUT" ? "WICKET" : correctedType;
    lastBall.runs = correctedRuns;
    lastBall.batter = oldBatterName;
    if (oldBowlerName) lastBall.bowler = oldBowlerName;
    lastBall.dismissalType = correctedType === "RUNOUT" ? "RUNOUT" : null;
    lastBall.dismissedPlayer =
      correctedType === "RUNOUT"
        ? dismissedPlayer || lastBall.dismissedPlayer || oldBatterName
        : null;
    recomputeFreeHit(innings);
    completeMatchIfTargetChased(match);

    await match.save();
    req.io.to(match._id.toString()).emit("match-updated", match);

    res.json(match);
  } catch (err) {
    console.error("EDIT LAST BALL ERROR:", err);
    res.status(500).json({ error: err.message });
  }
};





/* ================= ADD NEXT BATTER ================= */
export const addNextBatter = async (req, res) => {
  try {
    const { matchId, name, slot = "STRIKER" } = req.body;

    if (!matchId || !name) {
      return res.status(400).json({ error: "matchId and name required" });
    }

    if (!["STRIKER", "NON_STRIKER"].includes(slot)) {
      return res.status(400).json({ error: "Invalid slot" });
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
    if (slot === "STRIKER") {
      innings.striker = batter.name;
    } else {
      innings.nonStriker = batter.name;
    }

    await match.save();
    req.io.to(match._id.toString()).emit("match-updated", match);

    res.json(match);
  } catch (err) {
    console.error("ADD NEXT BATTER ERROR:", err);
    res.status(500).json({ error: err.message });
  }
};

// Declare innings (TEST only, by batting team choice) - can be done anytime after 1st innings end, even mid-over

export const declareInnings = async (req, res) => {
  try {
    const { matchId } = req.body;

    const match = await Match.findById(matchId);
    if (!match) return res.status(404).json({ error: "Match not found" });

    if (match.format !== "TEST")
      return res.status(400).json({ error: "Only allowed in TEST" });

    if (match.status !== "LIVE")
      return res.status(400).json({ error: "Match not live" });

    const innings = match.innings[match.currentInnings - 1];

    if (innings.isDeclared)
      return res.status(400).json({ error: "Already declared" });

    // 🔥 MARK DECLARED
    innings.isDeclared = true;
    if (!Array.isArray(match.declaredInnings)) {
      match.declaredInnings = [];
    }
    if (!match.declaredInnings.includes(innings.inningsNumber)) {
      match.declaredInnings.push(innings.inningsNumber);
    }

    // 🔥 MOVE TO NEXT INNINGS
    match.currentInnings += 1;

    // Create next innings object
    const nextBattingTeam =
      innings.bowlingTeam;

    const nextBowlingTeam =
      innings.battingTeam;

    const squad =
      nextBattingTeam === match.teams[0]
        ? match.squads.teamA
        : match.squads.teamB;

    match.innings.push({
      inningsNumber: match.currentInnings,
      battingTeam: nextBattingTeam,
      bowlingTeam: nextBowlingTeam,
      totalRuns: 0,
      wickets: 0,
      ballsBowled: 0,
      isFreeHit: false,
      isDeclared: false,
      striker: null,
      nonStriker: null,
      currentBowler: null,
      lastBowler: null,
      players: squad.map((p) => ({
        name: p.name,
        role: p.role,
        runs: 0,
        balls: 0,
        status: "YET_TO_BAT"
      })),
      ballsLog: []
    });

    if (match.currentInnings === 4) {
      setTestTargetForFourthInnings(match);
    }

    await match.save();

    req.io.to(match._id.toString()).emit("match-updated", match);

    res.json(match);
  } catch (err) {
    console.error("DECLARE ERROR:", err);
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
        format: 1,
        oversLimit: 1,
        scheduledAt: 1,
        currentInnings: 1,
        target: 1,
        result: 1,
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

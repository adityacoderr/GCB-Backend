import mongoose from "mongoose";

/* ================= BALL ================= */
const BallSchema = new mongoose.Schema(
  {
    over: Number, // 1,2,3...
    ball: Number, // 1..6 (legal ball count)
    type: {
      type: String,
      enum: ["RUN", "WICKET", "RUNOUT", "WIDE", "NOBALL"],
      required: true
    },
    runs: { type: Number, default: 0 },
    batter: String,
    bowler: String,
    dismissedPlayer: String,
    dismissalType: {
      type: String,
      enum: ["RUNOUT", null],
      default: null
    }
  },
  { _id: false }
);

/* ================= PLAYER ================= */
const PlayerSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    role: {
      type: String,
      enum: ["BATTER", "BOWLER", "ALL"],
      default: "BATTER"
    },

    // batting stats
    runs: { type: Number, default: 0 },
    balls: { type: Number, default: 0 },

    status: {
      type: String,
      enum: ["ON", "OUT", "YET_TO_BAT"],
      default: "YET_TO_BAT"
    }
  },
  { _id: false }
);

/* ================= INNINGS ================= */
const InningsSchema = new mongoose.Schema(
  {
    inningsNumber: { type: Number, required: true },

    battingTeam: String,
    bowlingTeam: String,

    totalRuns: { type: Number, default: 0 },
    wickets: { type: Number, default: 0 },

    ballsBowled: { type: Number, default: 0 }, // ✅ legal balls only
    isFreeHit: { type: Boolean, default: false },
    isDeclared: { type: Boolean, default: false },

    striker: { type: String, default: null },
    nonStriker: { type: String, default: null },

    currentBowler: { type: String, default: null },
    lastBowler: { type: String, default: null },

    // ✅ only batting team players stored here (scorecard)
    players: { type: [PlayerSchema], default: [] },

    ballsLog: { type: [BallSchema], default: [] }
  },
  { _id: false }
);

/* ================= MATCH ================= */
const MatchSchema = new mongoose.Schema(
  {
    teams: { type: [String], required: true },

    toss: {
      winner: { type: String, default: null },
      decision: {
        type: String,
        enum: ["BAT", "BOWL"],
        default: null
      }
    },

    format: {
      type: String,
      enum: ["TEST", "ODI"],
      required: true
    },

    oversLimit: { type: Number, required: true },
    scheduledAt: { type: Date, default: null },

    scorerPinHash: { type: String, required: true },

    currentInnings: { type: Number, default: 1 },

    maxInningsPerTeam: {
      type: Number,
      default: 1 // ODI default
    },

    target: {
      type: Number,
      default: null
    },

    followOn: {
      type: Boolean,
      default: false
    },

    declaredInnings: {
      type: [Number],
      default: []
    },

    isDeclared : {
      type: Boolean,
      default: false
    },

    result: {
      type: String,
      default: null
    },

    aiSummary: {
      type: mongoose.Schema.Types.Mixed,
      default: null
    },

    status: {
      type: String,
      enum: ["SETUP", "LIVE", "COMPLETED"],
      default: "SETUP"
    },

    squads: {
      teamA: { type: [PlayerSchema], default: [] },
      teamB: { type: [PlayerSchema], default: [] }
    },

    innings: { type: [InningsSchema], default: [] }
  },
  { timestamps: true }
);

export default mongoose.model("Match", MatchSchema);

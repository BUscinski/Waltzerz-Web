const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const dataDir = path.join(__dirname, "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

const db = new Database(path.join(dataDir, "busters.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS game_sessions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    played_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    player_count INTEGER,
    player_names TEXT
  );

  CREATE TABLE IF NOT EXISTS rounds (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      INTEGER REFERENCES game_sessions(id),
    round_number    INTEGER,
    prompter_name   TEXT,
    seed            TEXT,
    prompt_option_1 TEXT,
    prompt_option_2 TEXT,
    prompt_option_3 TEXT,
    chosen_prompt   TEXT
  );

  CREATE TABLE IF NOT EXISTS answers (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    round_id    INTEGER REFERENCES rounds(id),
    player_name TEXT,
    answer_text TEXT,
    votes       INTEGER,
    is_winner   INTEGER,
    is_ai       INTEGER
  );
`);

const insertSession = db.prepare(
  `INSERT INTO game_sessions (player_count, player_names) VALUES (?, ?)`
);

const insertRound = db.prepare(`
  INSERT INTO rounds
    (session_id, round_number, prompter_name, seed,
     prompt_option_1, prompt_option_2, prompt_option_3, chosen_prompt)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertAnswer = db.prepare(`
  INSERT INTO answers (round_id, player_name, answer_text, votes, is_winner, is_ai)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const saveGame = db.transaction((players, rounds) => {
  const { lastInsertRowid: sessionId } = insertSession.run(
    players.length,
    JSON.stringify(players)
  );

  for (const round of rounds) {
    const opts = round.promptOptions || [];
    const { lastInsertRowid: roundId } = insertRound.run(
      sessionId,
      round.round,
      round.prompter,
      round.seed || "",
      opts[0] || "",
      opts[1] || "",
      opts[2] || "",
      round.prompt
    );

    for (const answer of round.results || []) {
      insertAnswer.run(
        roundId,
        answer.name,
        answer.text,
        answer.votes,
        answer.name === round.winnerName ? 1 : 0,
        answer.isAI ? 1 : 0
      );
    }
  }

  return sessionId;
});

module.exports = { saveGame };

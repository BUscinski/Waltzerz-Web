const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

const credential = JSON.parse(process.env.FIREBASE_KEY);
initializeApp({ credential: cert(credential) });

const db = getFirestore();

async function saveGame(players, rounds) {
  const sessionRef = await db.collection("game_sessions").add({
    played_at: FieldValue.serverTimestamp(),
    player_count: players.length,
    player_names: players,
  });

  for (let i = 0; i < rounds.length; i++) {
    const round = rounds[i];
    const opts = round.promptOptions || [];

    const roundRef = await sessionRef.collection("rounds").add({
      round_number: round.round,
      prompter_name: round.prompter,
      seed: round.seed || "",
      prompt_option_1: opts[0] || "",
      prompt_option_2: opts[1] || "",
      prompt_option_3: opts[2] || "",
      chosen_prompt: round.prompt,
    });

    for (const answer of round.results || []) {
      await roundRef.collection("answers").add({
        player_name: answer.name,
        answer_text: answer.text,
        votes: answer.votes,
        is_winner: answer.name === round.winnerName,
        is_ai: !!answer.isAI,
      });
    }
  }

  return sessionRef.id;
}

module.exports = { saveGame };

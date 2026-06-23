const { OpenAI } = require("openai");

const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

const MODEL = "llama-3.1-8b-instant";
const ANSWER_SECS = 90;
const VOTE_SECS = 90;

async function aiCall(messages, maxTokens = 100) {
  const completion = await groq.chat.completions.create({
    model: MODEL,
    messages,
    max_tokens: maxTokens,
    temperature: 0.9,
  });
  return completion.choices?.[0]?.message?.content?.trim() || "";
}

async function generatePrompts(seed) {
  const text = await aiCall(
    [
      {
        role: "system",
        content:
          "You are a creative prompt generator for a party game like Quiplash. " +
          "Generate exactly 3 different, funny, short prompts. " +
          "Number them 1, 2, 3 — each on its own line. No extra explanation, just the prompts.",
      },
      { role: "user", content: `Generate 3 different Quiplash-style prompts about: ${seed}` },
    ],
    250
  );

  const prompts = text
    .split("\n")
    .map(l => l.replace(/^\d+[\.\)]\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 3);

  if (prompts.length === 0) throw new Error("No prompts returned");
  return prompts;
}

async function generateFallbackAnswer(prompt) {
  return aiCall(
    [
      {
        role: "system",
        content:
          "You are a witty player in a Quiplash party game. " +
          "Give a short, funny one-sentence answer. No explanation, just the answer.",
      },
      { role: "user", content: `Answer this prompt: ${prompt}` },
    ],
    60
  );
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function randomColor() {
  return "#" + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0");
}

module.exports = function setupBusters(ns) {
  let state = freshState();

  function freshState() {
    return {
      phase: "lobby",
      players: [],          // [{ id, name, color }] — join order matters
      prompterIndex: 0,
      currentPrompt: "",
      answers: {},          // socketId → { text, isAI }
      shuffledAnswers: [],  // [{ answerId: socketId, text, isAI }]
      votes: {},            // voterSocketId → answererSocketId
      roundHistory: [],
      timer: null,
    };
  }

  const prompter = () => state.players[state.prompterIndex] ?? null;

  function clearTimer() {
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
  }

  function startTimer(secs, fn) {
    clearTimer();
    state.timer = setTimeout(fn, secs * 1000);
  }

  // ── Phase transitions ──────────────────────────────────────────────────────

  function toPrompting() {
    state.phase = "prompting";
    state.currentPrompt = "";
    state.answers = {};
    state.votes = {};
    const p = prompter();
    if (!p) return;
    ns.emit("phase_prompting", { prompterId: p.id, prompterName: p.name });
  }

  async function toAnswering(prompt) {
    if (state.phase === "answering") return;
    state.phase = "answering";
    state.currentPrompt = prompt;
    state.answers = {};
    ns.emit("phase_answering", { prompt, timeLimit: ANSWER_SECS });
    startTimer(ANSWER_SECS, onAnswerTimeout);
  }

  async function onAnswerTimeout() {
    if (state.phase !== "answering") return;
    const missing = state.players.filter(p => !state.answers[p.id]);
    await Promise.all(
      missing.map(async p => {
        try {
          const text = await generateFallbackAnswer(state.currentPrompt);
          console.log(`AI fallback for ${p.name}: ${text}`);
          state.answers[p.id] = { text, isAI: true };
        } catch {
          state.answers[p.id] = { text: "...", isAI: true };
        }
        ns.emit("player_answered", { id: p.id, isAI: true });
      })
    );
    toVoting();
  }

  function checkAllAnswered() {
    if (state.phase !== "answering") return;
    if (state.players.every(p => state.answers[p.id])) {
      clearTimer();
      toVoting();
    }
  }

  function toVoting() {
    if (state.phase === "voting") return;
    state.phase = "voting";
    state.votes = {};

    state.shuffledAnswers = shuffle(
      Object.entries(state.answers).map(([id, { text, isAI }]) => ({
        answerId: id,
        text,
        isAI,
      }))
    );

    // Each phone gets a personalized list with their own answer excluded
    for (const player of state.players) {
      const sock = ns.sockets.get(player.id);
      if (sock) {
        sock.emit("phase_voting", {
          answers: state.shuffledAnswers.filter(a => a.answerId !== player.id),
          timeLimit: VOTE_SECS,
          prompt: state.currentPrompt,
        });
      }
    }

    ns.emit("phase_voting_host", {
      timeLimit: VOTE_SECS,
      prompt: state.currentPrompt,
    });

    startTimer(VOTE_SECS, toResults);
  }

  function checkAllVoted() {
    if (state.phase !== "voting") return;
    if (state.players.every(p => state.votes[p.id])) {
      clearTimer();
      toResults();
    }
  }

  function toResults() {
    if (state.phase === "results") return;
    state.phase = "results";
    clearTimer();

    const voteCounts = {};
    for (const answerId of Object.values(state.votes)) {
      voteCounts[answerId] = (voteCounts[answerId] || 0) + 1;
    }

    const results = state.shuffledAnswers.map(a => {
      const player = state.players.find(p => p.id === a.answerId);
      return {
        name: player?.name ?? "Unknown",
        color: player?.color ?? "#333",
        text: a.text,
        votes: voteCounts[a.answerId] || 0,
        isAI: a.isAI,
      };
    });

    const winner = results.reduce(
      (best, r) => (r.votes > (best?.votes ?? -1) ? r : best),
      null
    );

    const roundData = {
      round: state.roundHistory.length + 1,
      prompter: prompter()?.name ?? "Unknown",
      prompt: state.currentPrompt,
      results,
      winnerName: winner?.name ?? null,
      isLastRound: state.prompterIndex === state.players.length - 1,
    };

    state.roundHistory.push(roundData);
    ns.emit("phase_results", roundData);
  }

  function toNextRound() {
    if (state.phase !== "results") return;
    state.prompterIndex++;
    if (state.prompterIndex >= state.players.length) {
      toSummary();
    } else {
      toPrompting();
    }
  }

  function toSummary() {
    state.phase = "summary";
    const totalVotes = {};
    for (const p of state.players) totalVotes[p.name] = 0;
    for (const round of state.roundHistory) {
      for (const r of round.results) {
        totalVotes[r.name] = (totalVotes[r.name] || 0) + r.votes;
      }
    }
    ns.emit("phase_summary", { rounds: state.roundHistory, totalVotes });
  }

  // ── Socket handlers ────────────────────────────────────────────────────────

  ns.on("connection", socket => {
    console.log("Busters connected:", socket.id);

    socket.emit("game_state", {
      phase: state.phase,
      players: state.players.map(({ id, name, color }) => ({ id, name, color })),
      prompterIndex: state.prompterIndex,
      prompterName: prompter()?.name ?? null,
      currentPrompt: state.currentPrompt,
      answeredIds: Object.keys(state.answers),
    });

    socket.on("join", ({ name }) => {
      if (state.players.find(p => p.id === socket.id)) return;
      const color = randomColor();
      state.players.push({ id: socket.id, name, color });
      console.log(`Busters: ${name} joined (#${state.players.length})`);

      ns.emit("player_joined", { id: socket.id, name, color });

      if (state.players.length === 1 && state.phase === "lobby") {
        toPrompting();
      }
    });

    socket.on("submit_seed", async ({ seed }) => {
      if (state.phase !== "prompting") return;
      if (prompter()?.id !== socket.id) return;

      ns.emit("prompt_loading");
      try {
        const prompts = await generatePrompts(seed);
        console.log("Groq prompts:", prompts);
        state.phase = "selecting";
        // Only the prompter sees the choices
        const prompterSock = ns.sockets.get(prompter().id);
        if (prompterSock) prompterSock.emit("phase_selecting", { prompts });
        // Everyone else waits
        ns.emit("phase_selecting_wait", { prompterName: prompter().name });
      } catch (e) {
        console.error("Prompt generation failed:", e);
        state.phase = "prompting";
        ns.emit("prompt_error", { error: "Failed to generate prompts — please try again." });
      }
    });

    socket.on("select_prompt", async ({ prompt }) => {
      if (state.phase !== "selecting") return;
      if (prompter()?.id !== socket.id) return;
      await toAnswering(prompt);
    });

    socket.on("submit_answer", ({ text }) => {
      if (state.phase !== "answering") return;
      if (!state.players.find(p => p.id === socket.id)) return;
      if (state.answers[socket.id]) return;

      state.answers[socket.id] = { text, isAI: false };
      ns.emit("player_answered", { id: socket.id, isAI: false });
      console.log(`Answer from ${socket.id}: ${text}`);
      checkAllAnswered();
    });

    socket.on("submit_vote", ({ answerId }) => {
      if (state.phase !== "voting") return;
      if (!state.players.find(p => p.id === socket.id)) return;
      if (state.votes[socket.id]) return;
      if (answerId === socket.id) return; // no self-votes

      state.votes[socket.id] = answerId;
      ns.emit("player_voted", { id: socket.id });
      console.log(`Vote: ${socket.id} → ${answerId}`);
      checkAllVoted();
    });

    socket.on("next_round", () => toNextRound());

    socket.on("reset", () => {
      clearTimer();
      state = freshState();
      ns.emit("reset");
    });

    socket.on("disconnect", () => {
      const player = state.players.find(p => p.id === socket.id);
      if (!player) return;
      console.log(`Busters: ${player.name} disconnected`);

      const wasPrompter = prompter()?.id === socket.id;
      state.players = state.players.filter(p => p.id !== socket.id);
      ns.emit("player_left", { id: socket.id, name: player.name });

      if (state.players.length === 0) {
        clearTimer();
        state = freshState();
        return;
      }

      if (state.prompterIndex >= state.players.length) {
        state.prompterIndex = 0;
      }

      if (wasPrompter && state.phase === "prompting") {
        toPrompting();
      }
    });
  });
};

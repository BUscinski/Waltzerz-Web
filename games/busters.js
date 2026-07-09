const { releaseCode } = require("../lib/rooms");
const { OpenAI } = require("openai");

const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY || "missing-set-GROQ_API_KEY",
  baseURL: "https://api.groq.com/openai/v1",
});

const MODEL = "llama-3.3-70b-versatile";
const ANSWER_SECS = 90;
const VOTE_SECS = 90;

async function aiCall(messages, maxTokens = 100) {
  const completion = await groq.chat.completions.create({
    model: MODEL, messages, max_tokens: maxTokens, temperature: 0.9,
  });
  return completion.choices?.[0]?.message?.content?.trim() || "";
}

async function generatePrompts(seed) {
  const text = await aiCall([
    {
      role: "system",
      content:
        "You are a creative prompt generator for a party game. " +
        "Generate exactly 3 different, funny, short prompts. " +
        "Some examples: 'The worst thing to say to a bride on her wedding day', " +
        "'The most ridiculous law that exists in Florida'. " +
        "Number them 1, 2, 3 — each on its own line. No extra explanation, just the prompts.",
    },
    { role: "user", content: `Generate 3 different Quiplash-style prompts about: ${seed}` },
  ], 250);

  const prompts = text
    .split("\n")
    .map(l => l.replace(/^\d+[\.\)]\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 3);

  if (prompts.length === 0) throw new Error("No prompts returned");
  return prompts;
}

async function generateFallbackAnswer(prompt) {
  return aiCall([
    {
      role: "system",
      content: "You are a witty player in a Quiplash party game. Give a short, funny one-sentence answer. No explanation, just the answer.",
    },
    { role: "user", content: `Answer this prompt: ${prompt}` },
  ], 60);
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
  const rooms = {}; // roomCode → controller

  function initRoom(roomCode) {
    const state = {
      phase: "lobby",
      players: [],
      prompterIndex: 0,
      currentSeed: "",
      currentPrompt: "",
      promptOptions: [],
      answers: {},
      shuffledAnswers: [],
      votes: {},
      roundHistory: [],
      timer: null,
    };

    const emit = (...args) => ns.to(roomCode).emit(...args);
    const prompter = () => state.players[state.prompterIndex] ?? null;

    function clearTimer() {
      if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    }
    function startTimer(secs, fn) {
      clearTimer();
      state.timer = setTimeout(fn, secs * 1000);
    }

    function toPrompting() {
      state.phase = "prompting";
      state.currentPrompt = "";
      state.answers = {};
      state.votes = {};
      const p = prompter();
      if (!p) return;

      if (p.promptOptions && p.promptOptions.length > 0) {
        // Prompts already generated at join time — skip straight to selecting
        state.phase = "selecting";
        state.promptOptions = p.promptOptions;
        state.currentSeed = p.seed;
        const sock = ns.sockets.get(p.id);
        if (sock) sock.emit("phase_selecting", { prompts: p.promptOptions });
        emit("phase_selecting_wait", { prompterName: p.name });
      } else if (p.promptOptions === null) {
        // Still generating — the async join handler will advance to selecting when ready
        emit("phase_prompting", { prompterId: p.id, prompterName: p.name });
      } else {
        // Generation failed (empty array) — fall back to mid-game seed entry
        emit("phase_prompting", { prompterId: p.id, prompterName: p.name });
        const sock = ns.sockets.get(p.id);
        if (sock) sock.emit("prompt_retry", { message: "Prompt generation failed — please enter a new topic." });
      }
    }

    async function toAnswering(prompt) {
      if (state.phase === "answering") return;
      state.phase = "answering";
      state.currentPrompt = prompt;
      state.answers = {};
      emit("phase_answering", { prompt, timeLimit: ANSWER_SECS });
      startTimer(ANSWER_SECS, onAnswerTimeout);
    }

    async function onAnswerTimeout() {
      if (state.phase !== "answering") return;
      const missing = state.players.filter(p => !state.answers[p.id]);
      await Promise.all(missing.map(async p => {
        try {
          const text = await generateFallbackAnswer(state.currentPrompt);
          console.log(`AI fallback for ${p.name} in ${roomCode}: ${text}`);
          state.answers[p.id] = { text, isAI: true };
        } catch {
          state.answers[p.id] = { text: "...", isAI: true };
        }
        emit("player_answered", { id: p.id, isAI: true });
      }));
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
        Object.entries(state.answers).map(([id, { text, isAI }]) => ({ answerId: id, text, isAI }))
      );

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

      emit("phase_voting_host", { timeLimit: VOTE_SECS, prompt: state.currentPrompt });
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

      const winner = results.reduce((best, r) => (r.votes > (best?.votes ?? -1) ? r : best), null);

      const roundData = {
        round: state.roundHistory.length + 1,
        prompter: prompter()?.name ?? "Unknown",
        seed: state.currentSeed,
        promptOptions: state.promptOptions,
        prompt: state.currentPrompt,
        results,
        winnerName: winner?.name ?? null,
        isLastRound: state.prompterIndex === state.players.length - 1,
      };

      state.roundHistory.push(roundData);
      emit("phase_results", roundData);
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
      emit("phase_summary", { rounds: state.roundHistory, totalVotes });
    }

    function reset() {
      clearTimer();
      Object.assign(state, {
        phase: "lobby", players: [], prompterIndex: 0,
        currentSeed: "", currentPrompt: "", promptOptions: [],
        answers: {}, shuffledAnswers: [], votes: {}, roundHistory: [], timer: null,
      });
      emit("reset");
    }

    const controller = {
      state, emit, prompter, clearTimer,
      toPrompting, toAnswering, checkAllAnswered,
      toVoting, checkAllVoted, toResults, toNextRound, toSummary, reset,
    };

    rooms[roomCode] = controller;
    return controller;
  }

  // ── Connection handler ─────────────────────────────────────────────────────

  ns.on("connection", socket => {
    console.log("Busters connected:", socket.id);
    let roomCode = null;
    const rm = () => rooms[roomCode];

    socket.on("host_room", ({ roomCode: code }) => {
      roomCode = code;
      if (!rooms[roomCode]) initRoom(roomCode);
      socket.join(roomCode);
      console.log(`Busters host joined room: ${roomCode}`);
    });

    socket.on("join_room", ({ code, name, seed }) => {
      const uc = code?.trim().toUpperCase();
      if (!rooms[uc]) {
        socket.emit("room_error", { error: `Room "${uc}" not found. Check the code and try again.` });
        return;
      }
      roomCode = uc;
      socket.join(roomCode);

      const r = rm();
      if (r.state.players.find(p => p.id === socket.id)) return;

      const color = randomColor();
      const player = { id: socket.id, name, color, seed: seed || "", promptOptions: null };
      r.state.players.push(player);
      console.log(`Busters [${roomCode}]: ${name} joined with seed "${seed}" (#${r.state.players.length})`);

      r.emit("player_joined", { id: socket.id, name, color });

      socket.emit("game_state", {
        phase: r.state.phase,
        players: r.state.players.map(({ id, name, color }) => ({ id, name, color })),
        prompterIndex: r.state.prompterIndex,
        prompterName: r.prompter()?.name ?? null,
        currentPrompt: r.state.currentPrompt,
        answeredIds: Object.keys(r.state.answers),
      });

      // Generate prompts in the background immediately on join
      if (seed) {
        generatePrompts(seed)
          .then(prompts => {
            // Player may have left before prompts came back
            const p = r.state.players.find(p => p.id === socket.id);
            if (!p) return;
            p.promptOptions = prompts;
            console.log(`Prompts ready for ${name} [${roomCode}]:`, prompts);

            // If it's already this player's turn and we're waiting on them, advance now
            if (r.state.phase === "prompting" && r.prompter()?.id === socket.id) {
              r.state.phase = "selecting";
              r.state.promptOptions = prompts;
              r.state.currentSeed = seed;
              const sock = ns.sockets.get(socket.id);
              if (sock) sock.emit("phase_selecting", { prompts });
              r.emit("phase_selecting_wait", { prompterName: name });
            }
          })
          .catch(e => {
            console.error(`Prompt generation failed for ${name}:`, e);
            const p = r.state.players.find(p => p.id === socket.id);
            if (p) p.promptOptions = []; // empty = failed, toPrompting will handle it
          });
      }

      if (r.state.players.length === 1 && r.state.phase === "lobby") {
        r.toPrompting();
      }
    });

    // Fallback: only used if prompt generation failed at join time
    socket.on("submit_seed", async ({ seed }) => {
      const r = rm();
      if (!r || r.state.phase !== "prompting") return;
      if (r.prompter()?.id !== socket.id) return;
      r.emit("prompt_loading");
      try {
        const prompts = await generatePrompts(seed);
        const p = r.state.players.find(pl => pl.id === socket.id);
        if (p) { p.seed = seed; p.promptOptions = prompts; }
        r.state.phase = "selecting";
        r.state.promptOptions = prompts;
        r.state.currentSeed = seed;
        const sock = ns.sockets.get(socket.id);
        if (sock) sock.emit("phase_selecting", { prompts });
        r.emit("phase_selecting_wait", { prompterName: r.prompter()?.name });
      } catch (e) {
        console.error("Fallback prompt generation failed:", e);
        r.emit("prompt_error", { error: "Failed to generate prompts — please try again." });
      }
    });

    socket.on("select_prompt", async ({ prompt }) => {
      const r = rm();
      if (!r || r.state.phase !== "selecting") return;
      if (r.prompter()?.id !== socket.id) return;
      await r.toAnswering(prompt);
    });

    socket.on("submit_answer", ({ text }) => {
      const r = rm();
      if (!r || r.state.phase !== "answering") return;
      if (!r.state.players.find(p => p.id === socket.id)) return;
      if (r.state.answers[socket.id]) return;
      r.state.answers[socket.id] = { text, isAI: false };
      r.emit("player_answered", { id: socket.id, isAI: false });
      console.log(`[${roomCode}] Answer from ${socket.id}: ${text}`);
      r.checkAllAnswered();
    });

    socket.on("submit_vote", ({ answerId }) => {
      const r = rm();
      if (!r || r.state.phase !== "voting") return;
      if (!r.state.players.find(p => p.id === socket.id)) return;
      if (r.state.votes[socket.id]) return;
      if (answerId === socket.id) return;
      r.state.votes[socket.id] = answerId;
      r.emit("player_voted", { id: socket.id });
      console.log(`[${roomCode}] Vote: ${socket.id} → ${answerId}`);
      r.checkAllVoted();
    });

    socket.on("next_round", () => rm()?.toNextRound());

    socket.on("reset", () => rm()?.reset());

    socket.on("disconnect", () => {
      const r = rm();
      if (!r) return;
      const player = r.state.players.find(p => p.id === socket.id);
      if (!player) return;

      console.log(`Busters [${roomCode}]: ${player.name} disconnected`);
      const wasPrompter = r.prompter()?.id === socket.id;
      r.state.players = r.state.players.filter(p => p.id !== socket.id);
      r.emit("player_left", { id: socket.id, name: player.name });

      if (r.state.players.length === 0) {
        r.clearTimer();
        setTimeout(() => {
          if (rooms[roomCode]?.state.players.length === 0) {
            delete rooms[roomCode];
            releaseCode(roomCode);
            console.log(`Busters room ${roomCode} cleaned up`);
          }
        }, 5 * 60 * 1000);
        return;
      }

      if (r.state.prompterIndex >= r.state.players.length) r.state.prompterIndex = 0;
      if (wasPrompter && r.state.phase === "prompting") r.toPrompting();
    });
  });
};

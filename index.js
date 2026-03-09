const express = require("express");
const https = require("https");
const app = express();
app.use(express.json());

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const AIRCALL_API_ID = process.env.AIRCALL_API_ID;
const AIRCALL_API_TOKEN = process.env.AIRCALL_API_TOKEN;

const VOICE_ROLEPLAY_URL = "https://setryx-voice.up.railway.app";

const threadHistory = {};
const processedEvents = new Set();

const SYSTEM_PROMPT = `You are SetryX AI — the internal coaching intelligence for a coaching business. You operate in two distinct modes depending on what the rep sends you.

══════════════════════════════════════
MODE 1 — COACHING MODE
══════════════════════════════════════

When a rep asks you a question, wants advice, wants feedback on something they said, or wants to understand how to handle a situation — you are their coach. You respond as Samuel, the founder of this company, with Kurt Yewdale's voice layered on top.

WHO YOU ARE AS A COACH:
You are not a chatbot. You are not a script machine. You are the standard this team is held to. You speak directly, with belief in the rep and zero tolerance for mediocrity. You do not sugarcoat. You do not pad. You do not give generic sales advice — you give specific, principle-based coaching drawn from how this company actually operates.

YOUR COACHING VOICE (NON-NEGOTIABLE):
- Direct. Warm but uncompromising. Like a mentor who genuinely believes in you and refuses to let you stay average.
- Kurt Yewdale energy: sharp, accountable, real. No fluff. No word tracks. Actual insight.
- Draw from the 10 Dojo Values, the 5-Step Setter Framework, the four pillars, and the Scenario Rulebook — but NEVER name them robotically. Speak to the principles naturally.
- If a rep gives you an answer or response they used on a call, tell them honestly if it was good, where it broke down, and what elite looks like.
- If a rep asks how to handle an objection, give them the principle — not a script. Make them think, not repeat.
- Keep coaching responses concise. No essays. Make every word count.

FOUR PILLARS (coach from these always):
1. Master the Skillset
2. Outwork Everyone
3. Relentlessly Improve
4. Lead with Confidence, Not Ego

THE 10 DOJO VALUES (speak as life principles, never by number):
#1 Curiosity — beginners mindset always. The more you learn, the more there is to master.
#2 Authenticity — who you are speaks louder than what you say.
#3 Mindset — thoughts shape reality. Embody the result before it arrives.
#4 Boldness — one bold decision changes everything. Move first. Excuses fade when you act.
#5 Nuance — life is rarely black and white. Truth lives in the grey.
#6 Problem-Solving — problems signal progress. They beat strength out of you or into you.
#7 Action — volume negates luck. Relentless repetition wins. The grind is the shortcut.
#8 Memory — small wins compound. Show up consistently. Success remembers.
#9 Urgency — the perfect time is now. Waiting for conditions is procrastination dressed up.
#10 Integrity — respect, honesty, loyalty. Deceit erodes everything, including your own belief.

THE 5-STEP SETTER FRAMEWORK:
1. INTRO (30-60 sec): Professional confidence, quick time check, trust foundation. No fluff.
2. INTENT CHECK (60-90 sec): Uncover WHY they responded. Motivation, not logistics.
3. QUALIFICATION (60-120 sec): Financial readiness, time, decision authority — indirectly, never invasively.
4. VALUE BRIDGE (60-90 sec): Connect their goals to the expert call. Build anticipation without over-pitching.
5. BOOKING (max 5 min): Urgency from their stakes only. Handle objections. Push back. Confirm logistics.

FINANCIAL PRINCIPLES (coach these hard):
- Setters NEVER discuss specific investment numbers. Navigate the conversation — bring focus back to situation, goals, outcome.
- The strategy call is only positioned AFTER all qualification boxes are ticked. Never as a dodge.
- Financial qualification is done indirectly — assessing resourcefulness, seriousness, ability to move.
- Budget not confirmed = high risk deal. Excitement is not qualification. Dig.

SCENARIO COACHING:
- Partner objection: find out if partner can join the closer call. Booking without addressing = failure.
- "Think about it": push back. Find the real objection. Never let it go.
- Pricing question: navigate, don't deflect. Never give numbers unless absolute last resort hard qualify.
- Dominant prospect: match energy, lead harder. Never lose frame.
- "Sort finances first": dig into timeline. What does it actually mean? Don't book blindly.
- Previous failed attempt: dig into why. Use it as pain. Don't skip past it.
- Excited but vague on finances: dig deeper before booking. Excitement is not qualification.

══════════════════════════════════════
MODE 2 — REVIEW AND ANALYSIS MODE
══════════════════════════════════════

When a rep pastes a transcript, call notes, or setter notes:

PRIMARY RULE (NON-NEGOTIABLE):
If the user sends a transcript or call notes AND does NOT explicitly state "Deal Review", "Closer Brief", or "Performance Review", respond ONLY with:
"Got it. Do you want a Deal Review, a Closer Brief for the closer, or a Performance Review?"

MULTI-PART TRANSCRIPT RULE (NON-NEGOTIABLE):
If the user indicates they are sending a transcript in multiple parts (e.g. "part 1", "first half", "more coming", "don't respond yet"), respond ONLY with:
"Got it. Send the next part when ready."
Wait until the user says "done", "that's all", or "full transcript sent" — then ask what output they want.

If the user explicitly states:
- "Deal Review" -> generate Deal Review immediately.
- "Closer Brief" -> generate Closer Brief immediately.
- "Performance Review" -> generate Performance Review immediately.

LANGUAGE RULE: Always respond in English regardless of transcript language.

GLOBAL STANDARDS:
- Brutally conservative on close likelihood.
- Use only explicitly stated facts. No assumptions.
- Every output fits in ONE message. Ruthlessly concise. Max 2 sentences per scored category.
- All feedback directed at the setter — never the prospect.

FINANCIAL LOGIC:
- Budget not confirmed — Close Probability = LOW.
- Under 3K liquid: high risk. 3K-5K: viable but high friction.
- Setter disclosed numbers unprompted — Red Flag.
- Prospect hesitant about finding funds — Close Probability = LOW.

---

OUTPUT TYPE 1 — CLOSER BRIEF:
- Budget
- Intent (Low/Medium/High + short justification)
- Current Situation
- Desired Situation
- Why Now?
- Familiar with [Coach] for how long?
- Recognises they can't do it without a coach?
- Storyline Note (3-6 tight sentences)
- Open Loops
- Limiting Beliefs (if explicit)
- Red Flags (if explicit)

Missing info: any bullet except Budget -> "Not Confirmed - Setter Missed"
Budget missing -> "CRITICAL: Budget Not Confirmed - Do NOT close without reconfirming minimum 3K liquidity."

---

OUTPUT TYPE 2 — DEAL REVIEW:
SCORES
- Qualification: X/10
- Intent: X/10
- Accountability: X/10
- Urgency: X/10
- Authority: X/10
- Financial Strength: X/10

PROSPECT SNAPSHOT
- Thought Pattern: [1 line]
- Close Probability: Low / Medium / High

WHAT WENT WRONG
- [1 bullet per issue — max 10 words]

GAPS
- [1 bullet per missing qualification — max 10 words]

NEXT ACTIONS
- Setter: [1 line]
- Closer: [1 line]

SETTER IMPROVEMENT
- [Category] (X/10): [What went wrong] -> [Fix]

End with:
====================
OVERALL CALL SCORE: X/10
[One sentence verdict.]
====================

---

OUTPUT TYPE 3 — PERFORMANCE REVIEW:
Score 19 metrics 1-5:
1. Framework Flow 2. Introduction Energy 3. Intent Discovery 4. Qualification Precision 5. Value Bridge Creation 6. Belief Calibration 7. Listening Attentiveness 8. Emotion/Logic Balance 9. Call Control 10. Internal vs External Focus 11. Objection Prevention 12. Energy Management 13. Question Quality 14. Non-Buyer Recognition 15. Closer Positioning 16. Tonality Control (assume 3/5 if no clear cues) 17. Booking Mechanics 18. Call Duration Management (5/5=10-15min, 3/5=16-20 or under 8, 1/5=over 20 or under 5) 19. Value Focus

SCORING SCALE: 1=absent/damaging. 2=weak. 3=solid but improvable. 4=strong, minor gaps. 5=exemplary — earned.

Show full 19-point scorecard first, then deliver:

====================
Notes from SetryX AI
====================

The Standard You're Missing:
[Single weakest recurring principle tied to a transcript moment. Mentor tone — direct, believes in them, no sugarcoating.]

The One Thing:
[1-2 sentences. Root cause. Ruthlessly direct. One word of profanity max. Make them feel the gap.]

Fix These Now:
[3-4 sentences. Specific to this call. No generic advice.]

End with:
====================
OVERALL CALL SCORE: X/10
[One sentence verdict.]
====================

NEVER end any output without the Overall Call Score block.

BEHAVIOR ENFORCEMENT:
Never generate generic summaries. Only the clarification question or the exact requested format. No fluff. No invented details.`;

// ── Aircall API ──
function fetchAircallTranscript(callId) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${AIRCALL_API_ID}:${AIRCALL_API_TOKEN}`).toString("base64");
    const options = {
      hostname: "api.aircall.io",
      path: `/v1/calls/${callId}`,
      method: "GET",
      headers: {
        "Authorization": `Basic ${auth}`,
        "Content-Type": "application/json",
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          const call = parsed.call;
          if (!call) return reject(new Error("Call not found"));

          // Try to get transcript from transcription object
          let transcript = null;
          if (call.transcription && call.transcription.content) {
            transcript = call.transcription.content;
          } else if (call.transcript) {
            transcript = call.transcript;
          }

          if (!transcript) return reject(new Error("No transcript found for this call. Make sure AI transcription is enabled and the call has been processed."));

          const duration = call.duration ? `${Math.floor(call.duration / 60)}:${String(call.duration % 60).padStart(2, "0")}` : "Unknown";
          resolve({ transcript, duration, callId });
        } catch (e) {
          reject(new Error("Failed to parse Aircall response"));
        }
      });
    });

    req.on("error", reject);
    req.end();
  });
}

// ── Extract Aircall call ID from URL ──
function extractAircallCallId(text) {
  // Match patterns like:
  // https://dashboard.aircall.io/calls/12345678
  // https://app.aircall.io/calls/12345678
  const match = text.match(/aircall\.io\/(?:calls|call)\/(\d+)/i);
  return match ? match[1] : null;
}

function callClaude(messages) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      messages: messages,
    });

    const options = {
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            console.error("Anthropic error:", parsed.error);
            reject(new Error(parsed.error.message));
          } else {
            resolve(parsed.content?.[0]?.text || "No response.");
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function postToSlack(channel, text, threadTs) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ channel, text, thread_ts: threadTs });
    const options = {
      hostname: "slack.com",
      path: "/api/chat.postMessage",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SLACK_BOT_TOKEN}`,
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve(data));
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function isRoleplayRequest(message) {
  const lower = message.toLowerCase();
  return (
    lower.includes("roleplay") ||
    lower.includes("role play") ||
    lower.includes("voice mode") ||
    lower.includes("voice roleplay") ||
    lower.includes("practice call") ||
    lower.includes("mock call") ||
    lower.includes("simulate") ||
    lower.includes("simulation")
  );
}

app.post("/slack/events", async (req, res) => {
  const body = req.body;

  if (body.type === "url_verification") {
    return res.json({ challenge: body.challenge });
  }

  res.sendStatus(200);

  const event = body.event;
  if (!event) return;
  if (event.bot_id || event.subtype) return;

  const isAppMention = event.type === "app_mention";
  const isThreadReply = event.type === "message" && event.thread_ts && event.thread_ts !== event.ts;

  if (!isAppMention && !isThreadReply) return;

  const eventId = body.event_id;
  if (processedEvents.has(eventId)) return;
  processedEvents.add(eventId);
  setTimeout(() => processedEvents.delete(eventId), 60000);

  const channel = event.channel;
  const threadTs = event.thread_ts || event.ts;
  const userMessage = event.text?.replace(/<@[^>]+>/g, "").trim();

  if (!userMessage) return;

  // ── Roleplay trigger ──
  if (isRoleplayRequest(userMessage)) {
    await postToSlack(
      channel,
      `🎙 *Voice Roleplay Mode*\n\nOpen the link below to run a live call simulation with SetryX AI. Speak naturally — SetryX plays the prospect. When you end the call you'll get a full 19-metric Performance Review posted here in Slack.\n\n👉 ${VOICE_ROLEPLAY_URL}\n\n_Allow microphone access when prompted. Best used in Chrome._`,
      threadTs
    );
    return;
  }

  // ── Aircall URL trigger ──
  const aircallCallId = extractAircallCallId(userMessage);
  if (aircallCallId) {
    await postToSlack(channel, `⏳ Pulling transcript from Aircall...`, threadTs);
    try {
      const { transcript, duration } = await fetchAircallTranscript(aircallCallId);
      await postToSlack(channel, `✅ Got it — call duration: *${duration}*. Do you want a Deal Review, a Closer Brief for the closer, or a Performance Review?`, threadTs);

      // Store transcript in thread history for next message
      if (!threadHistory[threadTs]) threadHistory[threadTs] = [];
      threadHistory[threadTs].push({
        role: "user",
        content: `Here is the full call transcript pulled from Aircall (call ID: ${aircallCallId}, duration: ${duration}):\n\n${transcript}`
      });
    } catch (err) {
      console.error("Aircall error:", err.message);
      await postToSlack(channel, `❌ Couldn't pull the transcript: ${err.message}`, threadTs);
    }
    return;
  }

  // ── Normal flow ──
  if (!threadHistory[threadTs]) {
    threadHistory[threadTs] = [];
  }

  threadHistory[threadTs].push({ role: "user", content: userMessage });

  try {
    const reply = await callClaude(threadHistory[threadTs]);
    threadHistory[threadTs].push({ role: "assistant", content: reply });

    if (threadHistory[threadTs].length > 20) {
      threadHistory[threadTs] = threadHistory[threadTs].slice(-20);
    }

    await postToSlack(channel, reply, threadTs);
  } catch (err) {
    console.error("Error:", err.message);
    await postToSlack(channel, "Something went wrong: " + err.message, threadTs);
  }
});

app.get("/", (req, res) => res.send("SetryX AI is running."));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SetryX AI running on port ${PORT}`));

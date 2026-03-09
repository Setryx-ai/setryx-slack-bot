const express = require("express");
const https = require("https");
const { Pool } = require("pg");
const app = express();
app.use(express.json());

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const AIRCALL_API_ID = process.env.AIRCALL_API_ID;
const AIRCALL_API_TOKEN = process.env.AIRCALL_API_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;

const VOICE_ROLEPLAY_URL = "https://setryx-voice.up.railway.app";

const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

const threadHistory = {};
const processedEvents = new Set();

// ── Database setup ──
async function setupDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reviews (
      id SERIAL PRIMARY KEY,
      rep_name TEXT,
      channel TEXT,
      review_type TEXT,
      call_score NUMERIC,
      call_duration TEXT,
      overall_verdict TEXT,
      raw_review TEXT,
      metric_framework_flow INT,
      metric_intro_energy INT,
      metric_intent_discovery INT,
      metric_qualification INT,
      metric_value_bridge INT,
      metric_belief_calibration INT,
      metric_listening INT,
      metric_emotion_logic INT,
      metric_call_control INT,
      metric_internal_external INT,
      metric_objection_prevention INT,
      metric_energy_management INT,
      metric_question_quality INT,
      metric_nonbuyer_recognition INT,
      metric_closer_positioning INT,
      metric_tonality INT,
      metric_booking_mechanics INT,
      metric_duration_management INT,
      metric_value_focus INT,
      top_weaknesses TEXT[],
      close_probability TEXT,
      red_flags TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log("Database ready");
}

// ── Extract data from a Performance Review ──
function parsePerformanceReview(text, repName) {
  const data = { rep_name: repName, review_type: "performance", raw_review: text };

  // Extract overall score
  const scoreMatch = text.match(/OVERALL CALL SCORE:\s*(\d+(?:\.\d+)?)\s*\/\s*10/i);
  if (scoreMatch) data.call_score = parseFloat(scoreMatch[1]);

  // Extract verdict (line after overall score)
  const verdictMatch = text.match(/OVERALL CALL SCORE:.*\n([^\n=]+)/i);
  if (verdictMatch) data.overall_verdict = verdictMatch[1].trim();

  // Extract 19 metrics
  const metricMap = {
    "Framework Flow": "metric_framework_flow",
    "Introduction Energy": "metric_intro_energy",
    "Intent Discovery": "metric_intent_discovery",
    "Qualification Precision": "metric_qualification",
    "Value Bridge Creation": "metric_value_bridge",
    "Belief Calibration": "metric_belief_calibration",
    "Listening Attentiveness": "metric_listening",
    "Emotion/Logic Balance": "metric_emotion_logic",
    "Call Control": "metric_call_control",
    "Internal vs External Focus": "metric_internal_external",
    "Objection Prevention": "metric_objection_prevention",
    "Energy Management": "metric_energy_management",
    "Question Quality": "metric_question_quality",
    "Non-Buyer Recognition": "metric_nonbuyer_recognition",
    "Closer Positioning": "metric_closer_positioning",
    "Tonality Control": "metric_tonality",
    "Booking Mechanics": "metric_booking_mechanics",
    "Call Duration Management": "metric_duration_management",
    "Value Focus": "metric_value_focus",
  };

  for (const [name, col] of Object.entries(metricMap)) {
    const re = new RegExp(name.replace("/", "\\/") + ".*?(\\d)\\s*\\/\\s*5", "i");
    const m = text.match(re);
    if (m) data[col] = parseInt(m[1]);
  }

  // Extract top weaknesses (metrics scored 1 or 2)
  const weaknesses = [];
  for (const [name, col] of Object.entries(metricMap)) {
    if (data[col] && data[col] <= 2) weaknesses.push(name);
  }
  data.top_weaknesses = weaknesses;

  return data;
}

function parseDealReview(text, repName) {
  const data = { rep_name: repName, review_type: "deal", raw_review: text };

  const scoreMatch = text.match(/OVERALL CALL SCORE:\s*(\d+(?:\.\d+)?)\s*\/\s*10/i);
  if (scoreMatch) data.call_score = parseFloat(scoreMatch[1]);

  const verdictMatch = text.match(/OVERALL CALL SCORE:.*\n([^\n=]+)/i);
  if (verdictMatch) data.overall_verdict = verdictMatch[1].trim();

  const probMatch = text.match(/Close Probability:\s*(Low|Medium|High)/i);
  if (probMatch) data.close_probability = probMatch[1];

  const redFlagMatch = text.match(/Red Flags?:([\s\S]*?)(?=\n[A-Z]|\n==|$)/i);
  if (redFlagMatch) data.red_flags = redFlagMatch[1].trim();

  return data;
}

async function saveReview(data) {
  try {
    const cols = Object.keys(data).filter(k => data[k] !== undefined && data[k] !== null);
    const vals = cols.map(k => Array.isArray(data[k]) ? data[k] : data[k]);
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
    await pool.query(
      `INSERT INTO reviews (${cols.join(", ")}) VALUES (${placeholders})`,
      vals
    );
    console.log("Review saved to database");
  } catch (err) {
    console.error("Failed to save review:", err.message);
  }
}

// ── Manager analytics ──
const MANAGER_SYSTEM_PROMPT = `You are SetryX AI in Manager Mode. You have access to aggregated performance data from the team's calls. When given data, you analyse it and respond as a sharp, direct coaching intelligence. You identify patterns, name specific reps when relevant, and give actionable insight. Never waffle. Never be generic. Speak like a performance director who has seen every number and knows what it means.

When asked to create a coaching agenda or presentation outline, structure it clearly with sections, key points, and specific rep callouts where relevant. Format it so a manager could walk into a team meeting and run it directly.`;

async function getTeamAnalytics(days = 30) {
  const result = await pool.query(`
    SELECT 
      rep_name,
      COUNT(*) as total_calls,
      ROUND(AVG(call_score), 1) as avg_score,
      ROUND(AVG(metric_framework_flow), 1) as avg_framework,
      ROUND(AVG(metric_intro_energy), 1) as avg_intro,
      ROUND(AVG(metric_intent_discovery), 1) as avg_intent,
      ROUND(AVG(metric_qualification), 1) as avg_qualification,
      ROUND(AVG(metric_value_bridge), 1) as avg_value_bridge,
      ROUND(AVG(metric_belief_calibration), 1) as avg_belief,
      ROUND(AVG(metric_listening), 1) as avg_listening,
      ROUND(AVG(metric_call_control), 1) as avg_call_control,
      ROUND(AVG(metric_objection_prevention), 1) as avg_objection,
      ROUND(AVG(metric_booking_mechanics), 1) as avg_booking,
      ROUND(AVG(metric_question_quality), 1) as avg_questions,
      ROUND(AVG(metric_tonality), 1) as avg_tonality,
      ROUND(AVG(metric_energy_management), 1) as avg_energy,
      ROUND(AVG(metric_closer_positioning), 1) as avg_closer_positioning
    FROM reviews
    WHERE created_at > NOW() - INTERVAL '${days} days'
    AND review_type = 'performance'
    GROUP BY rep_name
    ORDER BY avg_score DESC
  `);
  return result.rows;
}

async function getWeaknesses(days = 30) {
  const result = await pool.query(`
    SELECT 
      unnest(top_weaknesses) as weakness,
      COUNT(*) as frequency
    FROM reviews
    WHERE created_at > NOW() - INTERVAL '${days} days'
    AND review_type = 'performance'
    GROUP BY weakness
    ORDER BY frequency DESC
    LIMIT 10
  `);
  return result.rows;
}

async function getRepTrend(repName, limit = 10) {
  const result = await pool.query(`
    SELECT call_score, call_duration, overall_verdict, created_at
    FROM reviews
    WHERE LOWER(rep_name) LIKE LOWER($1)
    AND review_type = 'performance'
    ORDER BY created_at DESC
    LIMIT $2
  `, [`%${repName}%`, limit]);
  return result.rows;
}

async function handleManagerQuery(userMessage, channel, threadTs) {
  const lower = userMessage.toLowerCase();

  let analyticsData = "";

  // Detect what they're asking for
  const dayMatch = lower.match(/(\d+)\s*days?/);
  const days = dayMatch ? parseInt(dayMatch[1]) : 30;

  // Rep trend query
  const trendMatch = lower.match(/how is ([a-z]+)\s*(doing|trending|performing)/i) ||
                     lower.match(/([a-z]+)'s (trend|progress|performance)/i);

  if (trendMatch) {
    const repName = trendMatch[1];
    const trend = await getRepTrend(repName);
    if (trend.length === 0) {
      await postToSlack(channel, `No reviews found for "${repName}" in the database yet.`, threadTs);
      return true;
    }
    analyticsData = `Rep trend for ${repName} (last ${trend.length} calls):\n` +
      trend.map((r, i) => `Call ${i+1}: Score ${r.call_score}/10 — ${r.overall_verdict} (${new Date(r.created_at).toLocaleDateString()})`).join("\n");
  } else {
    // Team-wide query
    const [teamData, weaknesses] = await Promise.all([
      getTeamAnalytics(days),
      getWeaknesses(days)
    ]);

    if (teamData.length === 0) {
      await postToSlack(channel, `No performance reviews in the database yet. Reviews will be stored automatically once the team starts submitting calls.`, threadTs);
      return true;
    }

    analyticsData = `TEAM PERFORMANCE DATA — Last ${days} days\n\n`;
    analyticsData += `INDIVIDUAL REP SCORES:\n`;
    teamData.forEach(rep => {
      analyticsData += `${rep.rep_name}: ${rep.avg_score}/10 avg (${rep.total_calls} calls reviewed)\n`;
      analyticsData += `  Key metrics: Framework ${rep.avg_framework}/5 | Qualification ${rep.avg_qualification}/5 | Booking ${rep.avg_booking}/5 | Questions ${rep.avg_questions}/5 | Objection Prevention ${rep.avg_objection}/5\n`;
    });

    analyticsData += `\nTEAM WEAKNESSES (by frequency):\n`;
    weaknesses.forEach(w => {
      analyticsData += `${w.weakness}: flagged ${w.frequency} times\n`;
    });
  }

  // Send to Claude with manager prompt
  const reply = await callClaudeWithSystem(MANAGER_SYSTEM_PROMPT, [
    { role: "user", content: `${analyticsData}\n\nManager question: ${userMessage}` }
  ]);

  await postToSlack(channel, reply, threadTs);
  return true;
}

function isManagerQuery(message) {
  const lower = message.toLowerCase();
  return (
    lower.includes("team") ||
    lower.includes("reps") ||
    lower.includes("struggling") ||
    lower.includes("weakness") ||
    lower.includes("weaknesses") ||
    lower.includes("trending") ||
    lower.includes("trend") ||
    lower.includes("coaching agenda") ||
    lower.includes("coaching deck") ||
    lower.includes("presentation") ||
    lower.includes("how is ") ||
    lower.includes("who is") ||
    lower.includes("analytics") ||
    lower.includes("stats") ||
    lower.includes("performance data") ||
    lower.includes("last 30") ||
    lower.includes("last 7") ||
    lower.includes("this month") ||
    lower.includes("leaderboard") ||
    lower.includes("top performer") ||
    lower.includes("bottom") ||
    lower.includes("improving") ||
    lower.includes("declining")
  );
}

// ── Aircall API ──
function fetchAircallTranscript(callId) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${AIRCALL_API_ID}:${AIRCALL_API_TOKEN}`).toString("base64");

    const getDuration = () => new Promise((res2) => {
      const opts = {
        hostname: "api.aircall.io",
        path: `/v1/calls/${callId}`,
        method: "GET",
        headers: { "Authorization": `Basic ${auth}`, "Content-Type": "application/json" },
      };
      const r = https.request(opts, (response) => {
        let d = "";
        response.on("data", c => d += c);
        response.on("end", () => {
          try {
            const p = JSON.parse(d);
            const dur = p.call?.duration;
            res2(dur ? `${Math.floor(dur/60)}:${String(dur%60).padStart(2,"0")}` : "Unknown");
          } catch { res2("Unknown"); }
        });
      });
      r.on("error", () => res2("Unknown"));
      r.end();
    });

    const options = {
      hostname: "api.aircall.io",
      path: `/v1/calls/${callId}/transcription`,
      method: "GET",
      headers: { "Authorization": `Basic ${auth}`, "Content-Type": "application/json" },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", async () => {
        try {
          console.log("Transcription raw:", data.substring(0, 500));
          const parsed = JSON.parse(data);
          let transcript = null;

          if (parsed.transcription) {
            const t = parsed.transcription;
            if (typeof t === "string") transcript = t;
            else if (t.content) transcript = t.content;
            else if (t.text) transcript = t.text;
            else if (Array.isArray(t.sentences)) {
              transcript = t.sentences.map(s => `${s.channel || s.speaker || ""}: ${s.text || s.content || ""}`).join("\n");
            } else if (Array.isArray(t)) {
              transcript = t.map(s => `${s.channel || s.speaker || ""}: ${s.text || s.content || ""}`).join("\n");
            }
          } else if (parsed.sentences) {
            transcript = parsed.sentences.map(s => `${s.channel || s.speaker || ""}: ${s.text || s.content || ""}`).join("\n");
          } else if (parsed.content) {
            transcript = parsed.content;
          } else if (parsed.text) {
            transcript = parsed.text;
          }

          if (!transcript) {
            return reject(new Error("Transcript not available. The call may still be processing — try again in a few minutes, or make sure AI Assist is enabled on this number in Aircall."));
          }

          const duration = await getDuration();
          resolve({ transcript, duration, callId });
        } catch (e) {
          reject(new Error("Failed to parse transcript: " + e.message));
        }
      });
    });

    req.on("error", reject);
    req.end();
  });
}

function extractAircallCallId(text) {
  const match = text.match(/aircall\.io\/calls\/(\d+)/i);
  return match ? match[1] : null;
}

// ── Claude API ──
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

function callClaude(messages) {
  return callClaudeWithSystem(SYSTEM_PROMPT, messages);
}

function callClaudeWithSystem(systemPrompt, messages) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4000,
      system: systemPrompt,
      messages,
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
          if (parsed.error) reject(new Error(parsed.error.message));
          else resolve(parsed.content?.[0]?.text || "No response.");
        } catch (e) { reject(e); }
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
    lower.includes("roleplay") || lower.includes("role play") ||
    lower.includes("voice mode") || lower.includes("practice call") ||
    lower.includes("mock call") || lower.includes("simulate")
  );
}

// ── Detect rep name from message context ──
function extractRepName(message, threadHistory) {
  // Look for "rep name: X" or "this is X's call" patterns
  const patterns = [
    /rep(?:\s+name)?[:\s]+([A-Z][a-z]+)/i,
    /this is ([A-Z][a-z]+)'s call/i,
    /([A-Z][a-z]+)'s performance review/i,
    /review for ([A-Z][a-z]+)/i,
  ];
  for (const p of patterns) {
    const m = message.match(p);
    if (m) return m[1];
  }
  // Check thread history for a name
  for (const msg of threadHistory) {
    for (const p of patterns) {
      const m = msg.content?.match(p);
      if (m) return m[1];
    }
  }
  return "Unknown";
}

app.post("/slack/events", async (req, res) => {
  const body = req.body;
  if (body.type === "url_verification") return res.json({ challenge: body.challenge });
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
    await postToSlack(channel,
      `🎙 *Voice Roleplay Mode*\n\nOpen the link below to run a live call simulation with SetryX AI. Speak naturally — SetryX plays the prospect. When you end the call you'll get a full 19-metric Performance Review posted here in Slack.\n\n👉 ${VOICE_ROLEPLAY_URL}\n\n_Allow microphone access when prompted. Best used in Chrome._`,
      threadTs);
    return;
  }

  // ── Manager analytics trigger ──
  if (isManagerQuery(userMessage)) {
    try {
      await handleManagerQuery(userMessage, channel, threadTs);
    } catch (err) {
      console.error("Manager query error:", err.message);
      await postToSlack(channel, `Error pulling analytics: ${err.message}`, threadTs);
    }
    return;
  }

  // ── Aircall URL trigger ──
  const aircallCallId = extractAircallCallId(userMessage);
  if (aircallCallId) {
    await postToSlack(channel, `⏳ Pulling transcript from Aircall...`, threadTs);
    try {
      const { transcript, duration } = await fetchAircallTranscript(aircallCallId);

      // Check if review type was specified in the same message
      const lowerMsg = userMessage.toLowerCase();
      const wantsPerformance = lowerMsg.includes("performance review") || lowerMsg.includes("performance");
      const wantsDeal = lowerMsg.includes("deal review") || lowerMsg.includes("deal");
      const wantsCloserBrief = lowerMsg.includes("closer brief") || lowerMsg.includes("closer");

      if (!threadHistory[threadTs]) threadHistory[threadTs] = [];
      threadHistory[threadTs].push({
        role: "user",
        content: `Here is the full call transcript pulled from Aircall (call ID: ${aircallCallId}, duration: ${duration}):\n\n${transcript}`
      });

      if (wantsPerformance || wantsDeal || wantsCloserBrief) {
        // Generate review immediately
        const reviewType = wantsPerformance ? "Performance Review" : wantsDeal ? "Deal Review" : "Closer Brief";
        threadHistory[threadTs].push({ role: "user", content: reviewType });
        const reply = await callClaude(threadHistory[threadTs]);
        threadHistory[threadTs].push({ role: "assistant", content: reply });
        await postToSlack(channel, reply, threadTs);

        // Save to database
        if (reply.includes("OVERALL CALL SCORE:")) {
          const repName = extractRepName(userMessage, threadHistory[threadTs]);
          let reviewData;
          if (wantsPerformance) reviewData = parsePerformanceReview(reply, repName);
          else if (wantsDeal) reviewData = parseDealReview(reply, repName);
          if (reviewData) {
            reviewData.channel = channel;
            reviewData.call_duration = duration;
            await saveReview(reviewData);
          }
        }
      } else {
        await postToSlack(channel, `✅ Got it — call duration: *${duration}*. Do you want a Deal Review, a Closer Brief for the closer, or a Performance Review?`, threadTs);
      }
    } catch (err) {
      console.error("Aircall error:", err.message);
      await postToSlack(channel, `❌ Couldn't pull the transcript: ${err.message}`, threadTs);
    }
    return;
  }

  // ── Normal flow ──
  if (!threadHistory[threadTs]) threadHistory[threadTs] = [];
  threadHistory[threadTs].push({ role: "user", content: userMessage });

  try {
    const reply = await callClaude(threadHistory[threadTs]);
    threadHistory[threadTs].push({ role: "assistant", content: reply });
    if (threadHistory[threadTs].length > 20) threadHistory[threadTs] = threadHistory[threadTs].slice(-20);

    await postToSlack(channel, reply, threadTs);

    // ── Auto-save reviews to database ──
    const lowerReply = reply.toLowerCase();
    const lowerMsg = userMessage.toLowerCase();

    if (reply.includes("OVERALL CALL SCORE:")) {
      const repName = extractRepName(userMessage, threadHistory[threadTs]);
      let reviewData;

      if (lowerMsg.includes("performance review") || reply.includes("Framework Flow")) {
        reviewData = parsePerformanceReview(reply, repName);
      } else if (lowerMsg.includes("deal review") || reply.includes("Close Probability")) {
        reviewData = parseDealReview(reply, repName);
      }

      if (reviewData) {
        reviewData.channel = channel;
        await saveReview(reviewData);
      }
    }

  } catch (err) {
    console.error("Error:", err.message);
    await postToSlack(channel, "Something went wrong: " + err.message, threadTs);
  }
});

app.get("/", (req, res) => res.send("SetryX AI is running."));

const PORT = process.env.PORT || 3000;
setupDatabase().then(() => {
  app.listen(PORT, () => console.log(`SetryX AI running on port ${PORT}`));
}).catch(err => {
  console.error("Database setup failed:", err.message);
  app.listen(PORT, () => console.log(`SetryX AI running (no DB) on port ${PORT}`));
});

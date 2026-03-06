const express = require("express");
const https = require("https");
const app = express();
app.use(express.json());

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;

const threadHistory = {};
const processedEvents = new Set();

const SYSTEM_PROMPT = `You are SetryX AI — a sales call analyst for coaching businesses. You help coaching companies analyse and improve their setters' sales calls. You create concise, actionable outputs from phone-based sales setting calls.

PRIMARY RULE (NON-NEGOTIABLE):
If the user sends a transcript, call notes, or setter notes AND does NOT explicitly state "Deal Review", "Airtable Note", or "Performance Review", you MUST respond ONLY with:

"Do you want a Deal Review, an Airtable Note, or a Performance Review?"

You must NOT summarize the transcript. You must NOT analyze the deal. You must NOT generate any output format. You must wait for the user to choose.

If the user explicitly states:
- "Deal Review" -> generate Deal Review immediately.
- "Airtable Note" -> generate Airtable Note immediately.
- "Performance Review" -> generate Performance Review immediately.

No exceptions.

LANGUAGE RULE: Always respond in English regardless of transcript language.

GLOBAL STANDARDS:
- Be brutally conservative on close likelihood.
- Use only explicitly stated facts from the transcript. No external assumptions.
- Tone: professional, direct, high standards, 100% ownership.
- Every output must fit in ONE single message. Be ruthlessly concise.
- All feedback is directed toward the setter/salesperson never the prospect.

FINANCIAL LOGIC:
- Setters do NOT discuss specific investment numbers on the phone.
- Financial qualification is done indirectly without quoting programme prices.
- If budget is NOT confirmed -> Close Probability defaults to LOW.
- If setter disclosed specific numbers unprompted -> flag as Red Flag.

OUTPUT TYPE 1 - AIRTABLE NOTE:
- Budget
- Intent (Low/Medium/High + justification)
- Current Situation
- Desired Situation
- Why Now?
- Familiar with [Coach] for how long?
- Recognises they need a coach?
- Storyline Note (3-6 sentences)
- Open Loops
- Limiting Beliefs (if explicit)
- Red Flags (if explicit)

Missing info: any missing bullet -> "Not Confirmed - Setter Missed"
Budget missing -> "CRITICAL: Budget Not Confirmed"

OUTPUT TYPE 2 - DEAL REVIEW:
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
- [max 10 words per bullet]

GAPS
- [max 10 words per bullet]

NEXT ACTIONS
- Setter: [1 line]
- Closer: [1 line]

SETTER IMPROVEMENT
- [Category] (X/10): [What went wrong] -> [Fix]

OUTPUT TYPE 3 - PERFORMANCE REVIEW:
Score 19 metrics 1-5 each, then deliver coaching feedback:

====================
Notes from SetryX AI
====================

The Standard You're Missing:
[Single weakest recurring principle tied to transcript moment. Mentor tone.]

The One Thing:
[1-2 sentences. Single root cause. Ruthlessly direct.]

Fix These Now:
[3-4 sentences. Specific to this call.]

Every output MUST end with:
====================
OVERALL CALL SCORE: X/10
[One sentence verdict.]
====================`;

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

app.post("/slack/events", async (req, res) => {
  const body = req.body;

  if (body.type === "url_verification") {
    return res.json({ challenge: body.challenge });
  }

  res.sendStatus(200);

  const event = body.event;
  if (!event) return;
  if (event.type !== "app_mention" && event.type !== "message") return;
  if (event.bot_id || event.subtype) return;

  const eventId = body.event_id;
  if (processedEvents.has(eventId)) return;
  processedEvents.add(eventId);
  setTimeout(() => processedEvents.delete(eventId), 60000);

  const channel = event.channel;
  const threadTs = event.thread_ts || event.ts;
  const userMessage = event.text?.replace(/<@[^>]+>/g, "").trim();

  if (!userMessage) return;

  if (!threadHistory[threadTs]) {
    threadHistory[threadTs] = [];
  }

  threadHistory[threadTs].push({ role: "user", content: userMessage });

  try {
    console.log("Calling Claude with message:", userMessage.substring(0, 50));
    const reply = await callClaude(threadHistory[threadTs]);
    console.log("Got reply from Claude, length:", reply.length);
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

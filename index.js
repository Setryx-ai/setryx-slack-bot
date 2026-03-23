const express = require('express');
const https   = require('https');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

process.on('uncaughtException',  (err)    => { console.error('Uncaught exception:', err.message); });
process.on('unhandledRejection', (reason) => { console.error('Unhandled rejection:', reason?.message || reason); });

// ============================================================
// SETRYX AI — SLACK BOT
// ============================================================

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SLACK_BOT_TOKEN   = process.env.SLACK_BOT_TOKEN;
const AIRCALL_API_ID    = process.env.AIRCALL_API_ID;
const AIRCALL_API_TOKEN = process.env.AIRCALL_API_TOKEN;
const DATABASE_URL      = process.env.DATABASE_URL;

const VOICE_ROLEPLAY_URL = 'https://setryx-voice.up.railway.app';

// ── CHANNEL IDS ──
// Set these as Railway environment variables, or paste the IDs directly
// To find a channel ID: right-click channel in Slack → View channel details → ID at the bottom
const ALERTS_CHANNEL       = process.env.ALERTS_CHANNEL       || 'REPLACE_WITH_ALERTS_CHANNEL_ID';
const DAILY_REPORT_CHANNEL = process.env.DAILY_REPORT_CHANNEL || 'REPLACE_WITH_DAILY_REPORT_CHANNEL_ID';
const REVIEW_CHANNEL       = process.env.REVIEW_CHANNEL       || 'REPLACE_WITH_REVIEW_CHANNEL_ID';

// ============================================================
// REP ROSTER
// To add a rep: copy any block, update all fields
// All hours are UK time (GMT in winter, BST in summer)
// monitorInactivity: false = excluded from inactivity alerts
// ============================================================

const REPS = [
  // { name: 'Alice', slackId: 'UXXXXXXXXX', aircallName: 'Alice Smith', monitorInactivity: true, startHour: 9, endHour: 18 },
  // { name: 'Bob',   slackId: 'UXXXXXXXXX', aircallName: 'Bob Jones',   monitorInactivity: true, startHour: 9, endHour: 18 },
];

// ============================================================
// MEETING BLACKOUTS — UK time
// day: 0=Sun 1=Mon 2=Tue 3=Wed 4=Thu 5=Fri 6=Sat
// Update these to match the client's actual meeting schedule
// ============================================================

const MEETING_BLACKOUTS = [
  { day: 1, startHour: 9,  startMin: 0, endHour: 10, endMin: 0 }, // Mon 9-10am
  { day: 2, startHour: 9,  startMin: 0, endHour: 10, endMin: 0 }, // Tue 9-10am
  { day: 3, startHour: 9,  startMin: 0, endHour: 10, endMin: 0 }, // Wed 9-10am
  { day: 4, startHour: 9,  startMin: 0, endHour: 10, endMin: 0 }, // Thu 9-10am
  { day: 5, startHour: 9,  startMin: 0, endHour: 10, endMin: 0 }, // Fri 9-10am
];

const alreadyAlertedToday = new Set();
const processedEvents     = new Set();

const pool = DATABASE_URL
  ? new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;
if (pool) pool.on('error', (err) => console.error('DB pool error:', err.message));

// ============================================================
// UK TIME HELPERS
// ============================================================

function getLastSunday(year, month) {
  const d = new Date(Date.UTC(year, month + 1, 0));
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d;
}

function isDST(date) {
  const y = date.getUTCFullYear();
  return date >= getLastSunday(y, 2) && date < getLastSunday(y, 9);
}

function getUKTime(date) {
  const offset = isDST(date) ? 1 : 0;
  const d = new Date(date.getTime() + offset * 3600000);
  return { hour: d.getUTCHours(), minute: d.getUTCMinutes(), day: d.getUTCDay() };
}

function isInMeetingBlackout(ukTime) {
  const mins = ukTime.hour * 60 + ukTime.minute;
  return MEETING_BLACKOUTS.some(b =>
    b.day === ukTime.day &&
    mins >= b.startHour * 60 + b.startMin &&
    mins <  b.endHour   * 60 + b.endMin
  );
}

function isRepOnShift(rep, ukTime) {
  return ukTime.hour >= rep.startHour && ukTime.hour < rep.endHour;
}

// ============================================================
// SYSTEM PROMPT
// ============================================================

const SYSTEM_PROMPT = `You are SetryX AI — an elite sales call analysis and coaching bot built for SDR (setter) performance in a high-ticket ecommerce coaching business.

You operate across 5 modes. Always detect which mode is being requested.

---

## HOW YOU RECEIVE CALLS

When a setter shares an Aircall link, you will receive the transcript from that call. Analyse the full transcript before responding in any mode.

---

## THE STANDARD YOU HOLD SETTERS TO

### THE SDR FRAMEWORK (10 Phases — This Is What You Score & Coach Against)

**PRINCIPLE:** The call is a conversation, not a script. Elite setters operate in discovery mode, not pitch mode. They are diagnosing fit, building belief, and creating urgency from the prospect's reality — not their own.

**PHASE 1 — FRAME CONTROL**
Opener: Natural, human, peer-to-peer tone. Not robotic. Confirms the prospect filled out an application. Does not ask permission — confirms reality. Sets tone as peer to peer, not salesperson to prospect. Leads from the first sentence.
If prospect can't talk: Offers a specific time — "later today or tomorrow morning?"

**PHASE 2 — INTENT DISCOVERY**
The Unlock Question: "So what's going on right now that made you reach out?"
NOT "why did you apply" or "what made you fill out the form."
Setter must let them talk, then dig.
Pattern: Surface answer → Dig → Emotional truth.
Goal: Get to the real WHY in under 2 minutes.

**PHASE 3 — PAIN EXPANSION**
"So if nothing changes and you're still in the same spot 6 months from now, what does that look like for you?"
Then: "How long have you been thinking about making a move?"
Listen for 4 gap types: Clarity gap | Confidence gap | Accountability gap | Investment fear

**PHASE 4 — FUTURE STATE**
"If we flash forward 6 months and everything's gone right, what does that look like?"
Not just money — freedom, time, respect, options. Build internal motivation.

**PHASE 5 — REALITY CHECK**
"Walk me through what you're doing right now, work wise."
Income Baseline: "What are you making now?"
Then: "Where do you need to be in the next 3-6 months for this to feel like it's working?"

**PHASE 6 — INVESTMENT FRAME**
"Building a real ecom brand requires investment. If this ends up being the right move for you, are you in a position to invest into your business?"
RULE: Do not book them to make numbers look good. Book them because they are qualified.

**PHASE 7 — BOTTLENECK IDENTIFICATION**
"If you've wanted this for [timeline], what's actually been in the way?"

**PHASE 8 — BRIDGE TO CLOSER**
"Based on everything you've told me — it sounds like you're serious about making this happen. The next step is getting you on a call with one of our senior coaches."

**PHASE 9 — BOOKING WITH URGENCY**
Live Transfer: "Are you free for the next 45 minutes to an hour, in a quiet place free of distraction?"
Scheduled: "What's your schedule like today or tomorrow?" — You control the calendar.
Collect: Name, email, time zone. Send confirmation.

**PHASE 10 — COMMITMENT LOCK**
"Other than a zombie apocalypse, is there any reason you couldn't make this call?"
Pause. Let them commit.

**DECISION MAKER CHECK:** If partner/spouse mentioned — push for joint call or don't book.

**ELITE MOVES:**
1. Match energy, then lead
2. Silence is a tool
3. Challenge without judgment
4. Never convince — only clarify
5. Disqualify ruthlessly
6. End every call knowing the truth

THE STANDARD: You are not a booking machine. You are a filter.

---

## THE ADVANCED COACHING METHODOLOGY

### THE 9 BUYING AVATARS
FEAR PATTERNS: The Avoider, The Victim, The People-Pleaser
LOGIC PATTERNS: The Rational, The Perfectionist, The Controlist
EGO PATTERNS: The Hard Worker, The Achiever, The Restless

### NORTH STAR FRAMEWORK
Find: Direction, Urgency, Relevancy — in first 2 minutes. Move them from curious → serious.

### PROBLEM AWARENESS TOOLS
- Quantify Everything — move from feeling to fact
- Stretch the Timeline — make chronic pain undeniable
- Spread the Cancer — show how the problem infects all areas
- Find the Shift — the specific recent event that triggered action
- The Impact Question — full audit summary + "how does that make you feel?"

### OBJECTION HANDLING — IDIC FRAMEWORK
Every objection = FEAR or LOGISTICS.
Fear Reframe Playbooks: Responsibility, Decision-Making, Self-Belief, Risk, Trust Deficit.
Avatar Challenge (master move): call out the pattern at the close directly.

---

## THE 5 MODES

### MODE 1: DEAL REVIEW
Trigger: Aircall link + "deal review"

🏢 *DEAL REVIEW — SETRYX AI*

*Prospect Name:*
*Setter:*
*Date:*
*Duration:*
*Outcome:*

━━━━━━━━━━━━━━━━━━━━
*PROSPECT SNAPSHOT*
━━━━━━━━━━━━━━━━━━━━

*Current situation:*
*Income baseline:*
*Desired outcome:*
*Timeline/urgency:*
*Buying Avatar:*
*Pain level (1–10):*
*Financial qualification:* [Green/Amber/Red]
*Decision maker:* [Confirmed/Unclear/Risk]

━━━━━━━━━━━━━━━━━━━━
*PHASE-BY-PHASE BREAKDOWN*
━━━━━━━━━━━━━━━━━━━━

Rate each phase: ✅ Executed Well | ⚠️ Partially Done | ❌ Missed

*Phase 1 — Frame Control:* [rating] — [One sentence]
*Phase 2 — Intent Discovery:* [rating] — [One sentence]
*Phase 3 — Pain Expansion:* [rating] — [One sentence]
*Phase 4 — Future State:* [rating] — [One sentence]
*Phase 5 — Reality Check:* [rating] — [One sentence]
*Phase 6 — Investment Frame:* [rating] — [One sentence]
*Phase 7 — Bottleneck ID:* [rating] — [One sentence]
*Phase 8 — Bridge to Closer:* [rating] — [One sentence]
*Phase 9 — Booking with Urgency:* [rating] — [One sentence]
*Phase 10 — Commitment Lock:* [rating] — [One sentence]

━━━━━━━━━━━━━━━━━━━━
*KEY MOMENTS*
━━━━━━━━━━━━━━━━━━━━

*Best moment:*
*Biggest missed opportunity:*
*Objections + how handled:*

━━━━━━━━━━━━━━━━━━━━

*BOOKING QUALITY SCORE: X/10*
*Verdict:* [Strong Book / Weak Book / Should Not Have Been Booked / Correct Disqualification]

*TOP 3 PRIORITIES FOR THE CLOSER:*
1.
2.
3.

### MODE 2: AIRTABLE NOTE
Trigger: Aircall link + "airtable note"

📋 *AIRTABLE NOTE — SETRYX AI*

*Prospect Name:*
*Setter:*
*Date:*
*Current Situation:*
*Pain Points:*
*Desired Outcome:*
*Timeline:*
*Income (Current → Target):*
*Financial Qualification:* [Yes/Maybe/No]
*Decision Maker:* [Yes/No/Needs Partner]
*Buying Avatar:*
*Gap Type:* [Clarity/Confidence/Accountability/Investment Fear]
*Urgency Level:* [High/Medium/Low]
*Booking Type:* [Live Transfer/Scheduled]
*Closer Notes:*
*Risk Flags:*

### MODE 3: PERFORMANCE REVIEW
Trigger: Aircall link + "performance review"

📊 *PERFORMANCE REVIEW — SETRYX AI*

*Setter:*
*Date:*
*Duration:*

━━━━━━━━━━━━━━━━━━━━
*SCORECARD*
━━━━━━━━━━━━━━━━━━━━

*Phase 1 — Frame Control: X/10*
*Phase 2 — Intent Discovery: X/10*
*Phase 3 — Pain Expansion: X/10*
*Phase 4 — Future State: X/10*
*Phase 5 — Reality Check: X/10*
*Phase 6 — Investment Frame: X/10*
*Phase 7 — Bottleneck ID: X/10*
*Phase 8 — Bridge to Closer: X/10*
*Phase 9 — Booking with Urgency: X/10*
*Phase 10 — Commitment Lock: X/10*

*OVERALL: X/100*

━━━━━━━━━━━━━━━━━━━━
*ELITE MOVES ASSESSMENT*
━━━━━━━━━━━━━━━━━━━━

*Energy matching:* ✅/⚠️/❌
*Use of silence:* ✅/⚠️/❌
*Challenging without judgment:* ✅/⚠️/❌
*Clarifying vs convincing:* ✅/⚠️/❌
*Disqualification discipline:* ✅/⚠️/❌

━━━━━━━━━━━━━━━━━━━━

*AVATAR DIAGNOSIS ACCURACY:*
*STRENGTHS:*
1.
2.
3.

*DEVELOPMENT AREAS:*
1.
2.
3.

*OVERALL RATING:* [Elite / Strong / Developing / Needs Improvement]

*ONE LINE SUMMARY:*

### MODE 4: COACHING MODE
Trigger: "coaching"
Direct. No fluff. Real scripts. Connect everything back to: does this get a qualified prospect booked?

### MODE 5: ROLEPLAY MODE
Trigger: "roleplay"
🎭 PROSPECT MODE or 🧠 COACH MODE. Ask which sub-mode. Stay in character. Debrief after.

## TONE & STYLE
Direct. No corporate waffle. High standards. Empathetic but challenging. Short sentences. High impact. Never lecture. Coach.`;

// ============================================================
// AIRCALL TRANSCRIPT FETCHER
// ============================================================

function fetchAircallTranscript(callId) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${AIRCALL_API_ID}:${AIRCALL_API_TOKEN}`).toString('base64');

    const getCallMeta = () => new Promise((res2) => {
      const r = https.request({
        hostname: 'api.aircall.io', path: `/v1/calls/${callId}`, method: 'GET',
        headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' },
      }, (response) => {
        let d = '';
        response.on('data', c => d += c);
        response.on('end', () => {
          try {
            const call = JSON.parse(d).call;
            const dur = call?.duration;
            res2({
              duration: dur ? `${Math.floor(dur/60)}:${String(dur%60).padStart(2,'0')}` : 'Unknown',
              repName: call?.user?.name || call?.user?.email?.split('@')[0] || 'Unknown'
            });
          } catch { res2({ duration: 'Unknown', repName: 'Unknown' }); }
        });
      });
      r.on('error', () => res2({ duration: 'Unknown', repName: 'Unknown' }));
      r.end();
    });

    const req = https.request({
      hostname: 'api.aircall.io', path: `/v1/calls/${callId}/transcription`, method: 'GET',
      headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', async () => {
        try {
          const parsed = JSON.parse(data);
          let transcript = null;
          const toText = (s) => {
            if (typeof s === 'string') return s;
            const t  = s.text || s.content || s.transcript || s.body || s.message || '';
            const sp = s.channel || s.speaker || s.author || s.name || '';
            return sp ? `${sp}: ${t}` : t;
          };
          const join = (arr) => arr.map(toText).filter(Boolean).join('\n');
          if (parsed.transcription) {
            const t = parsed.transcription;
            if (typeof t === 'string') transcript = t;
            else if (t.content && typeof t.content === 'string') transcript = t.content;
            else if (t.text   && typeof t.text   === 'string') transcript = t.text;
            else if (t.full_transcript) transcript = t.full_transcript;
            else if (Array.isArray(t.sentences))  transcript = join(t.sentences);
            else if (Array.isArray(t.utterances)) transcript = join(t.utterances);
            else if (Array.isArray(t))            transcript = join(t);
            else transcript = JSON.stringify(t);
          } else if (parsed.sentences)      transcript = join(parsed.sentences);
          else if (parsed.utterances)       transcript = join(parsed.utterances);
          else if (parsed.content)          transcript = parsed.content;
          else if (parsed.text)             transcript = parsed.text;
          else if (parsed.full_transcript)  transcript = parsed.full_transcript;
          if (!transcript) return reject(new Error('NO_TRANSCRIPT'));
          if (typeof transcript !== 'string') transcript = JSON.stringify(transcript);
          const { duration, repName } = await getCallMeta();
          resolve({ transcript, duration, repName, callId });
        } catch (e) { reject(new Error('Failed to parse transcript: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function extractAircallCallId(text) {
  const match = text.match(/aircall\.io\/calls\/(\d+)/i);
  return match ? match[1] : null;
}

function extractAllAircallCallIds(text) {
  return [...new Set([...text.matchAll(/aircall\.io\/calls\/(\d+)/gi)].map(m => m[1]))];
}

function detectMode(text) {
  const lower = text.toLowerCase();
  if (lower.includes('deal review'))    return 'deal_review';
  if (lower.includes('airtable note') || lower.includes('airtable')) return 'airtable_note';
  if (lower.includes('performance review')) return 'performance_review';
  if (lower.includes('coaching'))       return 'coaching';
  if (lower.includes('roleplay') || lower.includes('role play')) return 'roleplay';
  return null;
}

// ============================================================
// CALL CLAUDE API
// ============================================================

async function callClaude(messages) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: 'claude-opus-4-5', max_tokens: 4096, system: SYSTEM_PROMPT, messages });
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.content?.[0]) resolve(parsed.content[0].text);
          else reject(new Error('No content: ' + data));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ============================================================
// SLACK MESSAGING
// ============================================================

async function sendSlackMessage(channel, text, threadTs = null) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ channel, text, ...(threadTs && { thread_ts: threadTs }) });
    const req = https.request({
      hostname: 'slack.com', path: '/api/chat.postMessage', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SLACK_BOT_TOKEN}`,
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({}); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function sendSlackMessageAndGetTs(channel, text) {
  const result = await sendSlackMessage(channel, text);
  return result.ts || null;
}

async function sendFormattedResponse(channel, response, threadTs) {
  let formatted = response
    .replace(/\n([A-Z][A-Z\s\/\-]{3,}:)/g, '\n\n$1').replace(/\n(={3,})/g, '\n\n$1')
    .replace(/(={3,})\n/g, '$1\n\n').replace(/\n(-\s)/g, '\n\n$1')
    .replace(/\n(\d+\.\s)/g, '\n\n$1').replace(/\n{3,}/g, '\n\n');
  const maxLen = 3800;
  if (formatted.length <= maxLen) { await sendSlackMessage(channel, formatted, threadTs); return; }
  const chunks = [];
  let remaining = formatted;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) { chunks.push(remaining); break; }
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt === -1) splitAt = maxLen;
    chunks.push(remaining.substring(0, splitAt));
    remaining = remaining.substring(splitAt).trim();
  }
  for (const chunk of chunks) { await sendSlackMessage(channel, chunk, threadTs); await new Promise(r => setTimeout(r, 500)); }
}

// ============================================================
// AIRCALL DATA FETCHER — paginated, for daily report + inactivity
// ============================================================

async function fetchAircallCallsSince(fromTimestamp) {
  const auth = Buffer.from(`${AIRCALL_API_ID}:${AIRCALL_API_TOKEN}`).toString('base64');
  let allCalls = [], page = 1, hasMore = true;
  while (hasMore) {
    const calls = await new Promise((resolve) => {
      const req = https.request({
        hostname: 'api.aircall.io',
        path: `/v1/calls?started_after=${fromTimestamp}&per_page=50&page=${page}&order=asc`,
        method: 'GET',
        headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => { try { resolve(JSON.parse(data).calls || []); } catch { resolve([]); } });
      });
      req.on('error', () => resolve([]));
      req.end();
    });
    allCalls = allCalls.concat(calls);
    if (calls.length < 50 || page >= 20) hasMore = false;
    else page++;
  }
  return allCalls;
}

// ============================================================
// DAILY REPORT — fires at 8am UK time
// ============================================================

async function postDailyReport() {
  console.log('Generating daily report...');
  try {
    const now = new Date();
    const ukOffset = isDST(now) ? 1 : 0;
    const todayMidnightUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0 - ukOffset, 0, 0, 0);
    const fromTs = Math.floor((todayMidnightUTC / 1000) - 86400);
    const toTs   = Math.floor(todayMidnightUTC / 1000);

    const auth = Buffer.from(`${AIRCALL_API_ID}:${AIRCALL_API_TOKEN}`).toString('base64');
    let allCalls = [], page = 1, keepGoing = true;
    while (keepGoing) {
      const result = await new Promise((resolve) => {
        const req = https.request({
          hostname: 'api.aircall.io',
          path: `/v1/calls?from=${fromTs}&to=${toTs}&per_page=50&page=${page}&order=asc`,
          method: 'GET',
          headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' }
        }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({ calls: [] }); } });
        });
        req.on('error', () => resolve({ calls: [] }));
        req.end();
      });
      const calls = result.calls || [];
      allCalls = allCalls.concat(calls);
      if (calls.length < 50 || page >= 20) keepGoing = false;
      else page++;
    }

    const repStats = {};
    let totalInbound = 0;
    allCalls.forEach(c => {
      const name = c.user?.name || c.user?.email?.split('@')[0];
      if (c.direction === 'inbound') { totalInbound++; return; }
      if (c.direction !== 'outbound' || !name) return;
      if (!repStats[name]) repStats[name] = { dials: 0, connected: 0, totalDur: 0 };
      repStats[name].dials++;
      if (c.status === 'done' && (c.duration || 0) >= 60) {
        repStats[name].connected++;
        repStats[name].totalDur += c.duration;
      }
    });

    const active         = Object.entries(repStats).filter(([, s]) => s.dials > 0).sort((a, b) => b[1].dials - a[1].dials);
    const totalDials     = active.reduce((s, [, r]) => s + r.dials, 0);
    const totalConnected = active.reduce((s, [, r]) => s + r.connected, 0);
    const allDur         = active.reduce((s, [, r]) => s + r.totalDur, 0);
    const avgDur         = totalConnected > 0 ? Math.round(allDur / totalConnected) : 0;
    const repLines = active.map(([name, r]) => {
      const avg    = r.connected > 0 ? Math.round(r.totalDur / r.connected) : 0;
      const avgStr = avg > 0 ? `${Math.floor(avg/60)}m ${avg%60}s avg` : 'no connects';
      return `• ${name}: *${r.dials} dials* — ${r.connected} connected — ${avgStr}`;
    });

    const dateStr = new Date((fromTs + 43200) * 1000).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    let report = `📊 *Daily Performance Report — ${dateStr}*\n\n`;
    report += `━━━━━━━━━━━━━━━━━━━━\n*TEAM SUMMARY*\n━━━━━━━━━━━━━━━━━━━━\n\n`;
    report += `📞 Total outbound dials: *${totalDials}*\n`;
    report += `✅ Connected calls: *${totalConnected}*\n`;
    report += `📥 Inbound calls: *${totalInbound}*\n`;
    report += `⏱ Avg call duration: *${Math.floor(avgDur/60)}m ${avgDur%60}s*\n\n`;
    report += `━━━━━━━━━━━━━━━━━━━━\n*REP BREAKDOWN*\n━━━━━━━━━━━━━━━━━━━━\n\n`;
    report += repLines.length > 0 ? repLines.join('\n') : '_No outbound calls recorded yesterday._';
    await sendSlackMessage(DAILY_REPORT_CHANNEL, report);
    console.log('✅ Daily report posted.');
  } catch (err) { console.error('Daily report error:', err.message); }
}

// ============================================================
// INACTIVITY ALERTS
// ============================================================

const INACTIVITY_THRESHOLD_MS = 90 * 60 * 1000;

async function checkInactivity() {
  const now = new Date();
  const ukTime = getUKTime(now);
  if (ukTime.day === 0 || ukTime.day === 6) return;
  if (isInMeetingBlackout(ukTime)) { console.log('Inactivity check skipped — meeting blackout.'); return; }
  try {
    const ninetyMinsAgo = Math.floor((Date.now() - INACTIVITY_THRESHOLD_MS) / 1000);
    const recentCalls   = await fetchAircallCallsSince(ninetyMinsAgo);
    const activeReps    = new Set();
    recentCalls.forEach(c => {
      if (c.direction !== 'outbound') return;
      const name = c.user?.name || c.user?.email?.split('@')[0];
      if (name) activeReps.add(name.toLowerCase());
    });
    const ukOffset   = isDST(now) ? 1 : 0;
    const todayStart = new Date(now);
    todayStart.setUTCHours(0 - ukOffset, 0, 0, 0);
    const todayCalls = await fetchAircallCallsSince(Math.floor(todayStart.getTime() / 1000));
    for (const rep of REPS) {
      if (!rep.monitorInactivity || alreadyAlertedToday.has(rep.slackId)) continue;
      if (!isRepOnShift(rep, ukTime)) continue;
      if (activeReps.has(rep.aircallName.toLowerCase())) continue;
      const hasCalledToday = todayCalls.some(c => {
        const name = c.user?.name || c.user?.email?.split('@')[0];
        return name?.toLowerCase() === rep.aircallName.toLowerCase() && c.direction === 'outbound';
      });
      if (hasCalledToday) {
        await sendSlackMessage(ALERTS_CHANNEL, `⚠️ *Inactivity Alert* — <@${rep.slackId}> hasn't dialled in over 90 minutes. Get back on the phones! 📞`);
        alreadyAlertedToday.add(rep.slackId);
      }
    }
  } catch (err) { console.error('Inactivity check error:', err.message); }
}

// ============================================================
// SCHEDULERS
// ============================================================

function startSchedulers() {
  setInterval(() => {
    const ukTime = getUKTime(new Date());
    if (ukTime.hour === 8 && ukTime.minute === 0) postDailyReport().catch(console.error);
    if (ukTime.hour === 0 && ukTime.minute === 0) { alreadyAlertedToday.clear(); console.log('Alert list reset.'); }
  }, 60 * 1000);
  setInterval(() => checkInactivity().catch(console.error), 15 * 60 * 1000);
  console.log('Schedulers started.');
}

// ============================================================
// MANAGER ANALYTICS
// ============================================================

function isManagerQuery(text) {
  const lower = text.toLowerCase();
  return (
    lower.includes('best performer') || lower.includes('worst performer') || lower.includes('top performer') ||
    lower.includes('leaderboard') || lower.includes('whos the best') || lower.includes('who is the best') ||
    lower.includes('whos the worst') || lower.includes('who is the worst') || lower.includes('team performance') ||
    lower.includes('team average') || lower.includes('biggest weakness') || lower.includes('biggest bottleneck') ||
    lower.includes('most common weakness') || lower.includes('most common issue') || lower.includes('how is the team') ||
    lower.includes('how are the reps') || lower.includes('last 10 calls') || lower.includes('last 5 calls') ||
    lower.includes('this week') || lower.includes('this month') ||
    (lower.includes('how is') && lower.includes('doing')) || (lower.includes('how has') && lower.includes('been')) ||
    lower.includes('rep stats') || lower.includes('rep data') || lower.includes('team stats') ||
    lower.includes('weakest area') || lower.includes('strongest area') || lower.includes('improving') ||
    lower.includes('declining') || lower.includes('trend') || lower.includes('coaching agenda') ||
    lower.includes('who needs') || lower.includes('focus on')
  );
}

async function handleManagerQuery(question, channel, threadTs) {
  if (!pool) { await sendSlackMessage(channel, '❌ Database not connected.', threadTs); return; }
  try {
    const repScores = await pool.query(`
      SELECT rep_name, COUNT(*) as total_calls, ROUND(AVG(call_score),1) as avg_score,
        ROUND(AVG(metric_framework_flow),1) as avg_framework, ROUND(AVG(metric_intent_discovery),1) as avg_intent,
        ROUND(AVG(metric_qualification),1) as avg_qualification, ROUND(AVG(metric_call_control),1) as avg_call_control,
        ROUND(AVG(metric_booking_mechanics),1) as avg_booking, ROUND(AVG(metric_question_quality),1) as avg_questions,
        ROUND(AVG(metric_objection_prevention),1) as avg_objection, ROUND(AVG(metric_tonality),1) as avg_tonality,
        ROUND(AVG(metric_closer_positioning),1) as avg_closer
      FROM reviews WHERE review_type='performance' AND created_at > NOW() - INTERVAL '30 days'
      GROUP BY rep_name ORDER BY avg_score DESC
    `);
    if (repScores.rows.length === 0) {
      await sendSlackMessage(channel, 'No performance review data yet. Data builds up as calls are reviewed throughout the day.', threadTs);
      return;
    }
    const weaknesses = await pool.query(`
      SELECT unnest(top_weaknesses) as weakness, COUNT(*) as frequency
      FROM reviews WHERE review_type='performance' AND created_at > NOW() - INTERVAL '30 days'
      GROUP BY weakness ORDER BY frequency DESC LIMIT 10
    `);
    const recentCalls = await pool.query(`
      SELECT rep_name, call_score, overall_verdict, call_duration, created_at
      FROM reviews WHERE review_type='performance' ORDER BY created_at DESC LIMIT 10
    `);
    let summary = `TEAM DATA — Last 30 days\n\n`;
    repScores.rows.forEach(r => {
      summary += `${r.rep_name}: ${r.avg_score}/10 (${r.total_calls} calls)\n  Framework:${r.avg_framework} Intent:${r.avg_intent} Qualification:${r.avg_qualification} Control:${r.avg_call_control} Booking:${r.avg_booking} Questions:${r.avg_questions} Objection:${r.avg_objection} Tonality:${r.avg_tonality} Closer:${r.avg_closer}\n`;
    });
    summary += `\nWEAKNESSES:\n`;
    weaknesses.rows.forEach(w => { summary += `${w.weakness}: ${w.frequency}x\n`; });
    summary += `\nLAST 10 CALLS:\n`;
    recentCalls.rows.forEach(c => { summary += `${c.rep_name}: ${c.call_score}/10 — ${c.overall_verdict}\n`; });
    await sendSlackMessage(channel, '📊 Pulling team data...', threadTs);
    const response = await callClaude([{ role: 'user', content: `SetryX AI performance director. Data:\n\n${summary}\n\nQuestion: ${question}\n\nAnswer directly. Name reps. Give numbers. No fluff.` }]);
    await sendFormattedResponse(channel, response, threadTs);
  } catch (err) {
    console.error('Manager query error:', err.message);
    await sendSlackMessage(channel, '❌ Something went wrong pulling team data.', threadTs);
  }
}

// ============================================================
// DATABASE — save performance reviews
// ============================================================

function parsePerformanceReview(text, repName, duration) {
  const data = { rep_name: repName, review_type: 'performance', raw_review: text, call_duration: duration };
  const scoreMatch = text.match(/OVERALL(?:\s+CALL)?\s+SCORE:\s*(\d+(?:\.\d+)?)\s*\/\s*10/i) ||
                     text.match(/\*OVERALL:\*?\s*(\d+)\s*\/\s*100/i) ||
                     text.match(/OVERALL:\s*(\d+)\s*\/\s*100/i);
  if (scoreMatch) {
    const raw = parseFloat(scoreMatch[1]);
    data.call_score = raw > 10 ? Math.round(raw / 10) : raw;
  }
  const verdictMatch = text.match(/ONE LINE SUMMARY[:\s]*\n?([^\n]+)/i);
  if (verdictMatch) data.overall_verdict = verdictMatch[1].trim();
  const metricMap = {
    'Framework Flow': 'metric_framework_flow', 'Frame Control': 'metric_framework_flow',
    'Intent Discovery': 'metric_intent_discovery', 'Qualification': 'metric_qualification',
    'Bridge to Closer': 'metric_value_bridge', 'Belief Calibration': 'metric_belief_calibration',
    'Listening': 'metric_listening', 'Call Control': 'metric_call_control',
    'Objection Prevention': 'metric_objection_prevention', 'Energy Management': 'metric_energy_management',
    'Question Quality': 'metric_question_quality', 'Non-Buyer Recognition': 'metric_nonbuyer_recognition',
    'Closer Positioning': 'metric_closer_positioning', 'Tonality': 'metric_tonality',
    'Booking': 'metric_booking_mechanics',
  };
  for (const [name, col] of Object.entries(metricMap)) {
    const re = new RegExp(name.replace(/[\/()]/g, '.') + '[^\\n]*?(\\d+)\\s*\\/\\s*(?:5|10)', 'i');
    const m  = text.match(re);
    if (m && !data[col]) {
      const raw = parseInt(m[1]);
      data[col] = text.match(new RegExp(name + '[^\\n]*?\\d+\\s*\\/\\s*10', 'i')) ? Math.round(raw / 2) : raw;
    }
  }
  data.top_weaknesses = Object.entries(metricMap).filter(([, col]) => data[col] && data[col] <= 2).map(([name]) => name);
  return data;
}

async function saveReview(data) {
  if (!pool) return;
  try {
    const cols = Object.keys(data).filter(k => data[k] !== undefined && data[k] !== null);
    const vals = cols.map(k => data[k]);
    await pool.query(`INSERT INTO reviews (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i+1}`).join(', ')})`, vals);
    console.log('Review saved for:', data.rep_name);
  } catch (err) { console.error('Failed to save review:', err.message); }
}

async function tryAutoSave(response, repName, duration, channel, callId = null) {
  if (!response.includes('OVERALL') || !response.match(/\d+\/10/)) return;
  try {
    const data = parsePerformanceReview(response, repName, duration);
    if (data.call_score) {
      data.channel = channel;
      if (callId) data.aircall_call_id = callId;
      await saveReview(data);
    }
  } catch (err) { console.error('Auto-save error:', err.message); }
}

// ============================================================
// PROCESS SLACK EVENT
// ============================================================

async function processEvent(event) {
  const channel   = event.channel;
  const threadTs  = event.thread_ts || event.ts;
  const cleanText = (event.text || '').replace(/<@[A-Z0-9]+>/g, '').trim();

  if (!cleanText) {
    await sendSlackMessage(channel,
      `Hey! Here's what I can do:\n\n• *Paste an Aircall link* — Deal Review, Airtable Note, or Performance Review\n• *Ask a coaching question* — I'll answer based on the SetryX framework\n• *"Roleplay"* — sends the Voice Trainer link\n• *"Who's the top performer?"* — manager analytics`,
      threadTs);
    return;
  }

  const aircallCallId  = extractAircallCallId(cleanText);
  const aircallCallIds = extractAllAircallCallIds(cleanText);
  const mode           = detectMode(cleanText);

  if (mode === 'roleplay') {
    await sendSlackMessage(channel,
      `🎙️ *Voice Roleplay Mode*\n\nClick the link below to start a live call simulation. The AI plays the prospect — you run the call as the setter. When you hang up you'll get a full Performance Review posted back here.\n\n👉 *${VOICE_ROLEPLAY_URL}*\n\n_Allow microphone access when prompted. Best used on Chrome._`,
      threadTs);
    return;
  }

  if (isManagerQuery(cleanText)) { await handleManagerQuery(cleanText, channel, threadTs); return; }

  if (aircallCallIds.length > 1) {
    await sendSlackMessage(channel, `⏳ Pulling ${aircallCallIds.length} transcripts from Aircall...`, threadTs);
    try {
      const results = await Promise.allSettled(aircallCallIds.map(id => fetchAircallTranscript(id)));
      const successful = [], failed = [];
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') successful.push({ callId: aircallCallIds[i], ...r.value });
        else failed.push(aircallCallIds[i]);
      });
      if (successful.length === 0) { await sendSlackMessage(channel, '❌ Couldn\'t pull any transcripts. Make sure the calls have AI transcription enabled.', threadTs); return; }
      if (failed.length > 0) await sendSlackMessage(channel, `⚠️ Got ${successful.length}/${aircallCallIds.length} transcripts. ${failed.length} couldn't be fetched.`, threadTs);
      else await sendSlackMessage(channel, `✅ Got all ${successful.length} transcripts. Analysing...`, threadTs);
      const question = cleanText.replace(/https?:\/\/[^\s]*/gi, '').replace(/<@[^>]+>/g, '').trim();
      const combinedTranscripts = successful.map((c, i) => `━━━ CALL ${i+1} — ${c.repName} | ${c.duration} ━━━\n${c.transcript}`).join('\n\n');
      const systemMsg = `SetryX AI Coach. ${successful.length} transcripts to analyse. Never fabricate.\n\n${combinedTranscripts}`;
      const userMsg   = question || 'What patterns do you see across these calls?';
      if (!global.threadHistory) global.threadHistory = {};
      global.threadHistory[threadTs] = { system: systemMsg, messages: [{ role: 'user', content: userMsg }] };
      const response = await callClaude([{ role: 'user', content: `${systemMsg}\n\n━━━ QUESTION ━━━\n${userMsg}` }]);
      global.threadHistory[threadTs].messages.push({ role: 'assistant', content: response });
      await sendFormattedResponse(channel, response, threadTs);
    } catch (err) { await sendSlackMessage(channel, `❌ Error: ${err.message}`, threadTs); }
    return;
  }

  if (aircallCallId) {
    await sendSlackMessage(channel, '⏳ Pulling transcript from Aircall...', threadTs);
    try {
      const { transcript, duration, repName } = await fetchAircallTranscript(aircallCallId);
      const lower            = cleanText.toLowerCase();
      const wantsPerformance = lower.includes('performance review');
      const wantsDeal        = lower.includes('deal review');
      const wantsAirtable    = lower.includes('airtable note') || lower.includes('airtable');
      const transcriptContext = `SetryX AI Coach. Base ALL answers on this transcript only.\n\nCall by: ${repName}\nDuration: ${duration}\nCall ID: ${aircallCallId}\n\nFULL TRANSCRIPT:\n${transcript}`;
      if (!global.threadHistory) global.threadHistory = {};
      global.threadHistory[threadTs] = { transcriptContext, repName, duration, callId: aircallCallId, messages: [] };
      if (!wantsPerformance && !wantsDeal && !wantsAirtable) {
        await sendSlackMessage(channel,
          `✅ Got it — call by *${repName}*, duration: *${duration}*.\n\nWhat do you want?\n• *Deal Review*\n• *Airtable Note*\n• *Performance Review*`,
          threadTs);
        return;
      }
      const reviewType = wantsPerformance ? 'Performance Review' : wantsDeal ? 'Deal Review' : 'Airtable Note';
      const response   = await callClaude([{ role: 'user', content: `${transcriptContext}\n\n${reviewType}` }]);
      global.threadHistory[threadTs].messages.push({ role: 'user', content: reviewType });
      global.threadHistory[threadTs].messages.push({ role: 'assistant', content: response });
      await sendFormattedResponse(channel, response, threadTs);
      if (wantsPerformance) await tryAutoSave(response, repName, duration, channel, aircallCallId);
    } catch (err) { await sendSlackMessage(channel, `❌ Couldn't pull the transcript: ${err.message}`, threadTs); }
    return;
  }

  if (!global.threadHistory) global.threadHistory = {};
  if (global.threadHistory[threadTs]) {
    const thread     = global.threadHistory[threadTs];
    const lower      = cleanText.toLowerCase();
    const wantsPerformance = lower.includes('performance review') || lower === 'performance';
    const wantsDeal        = lower.includes('deal review') || lower === 'deal';
    const wantsAirtable    = lower.includes('airtable note') || lower.includes('airtable');
    await sendSlackMessage(channel, '⚡ Analysing...', threadTs);
    let userMessage;
    if ((wantsPerformance || wantsDeal || wantsAirtable) && thread.transcriptContext) {
      const reviewType = wantsPerformance ? 'Performance Review' : wantsDeal ? 'Deal Review' : 'Airtable Note';
      userMessage = `${thread.transcriptContext}\n\n${reviewType}`;
      thread.messages.push({ role: 'user', content: reviewType });
    } else {
      const history = thread.messages.slice(-10);
      userMessage = `${thread.transcriptContext || thread.system}\n\nPREVIOUS CONVERSATION:\n${history.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n')}\n\nNEW QUESTION: ${cleanText}`;
      thread.messages.push({ role: 'user', content: cleanText });
    }
    try {
      const response = await callClaude([{ role: 'user', content: userMessage }]);
      thread.messages.push({ role: 'assistant', content: response });
      if (thread.messages.length > 20) thread.messages = thread.messages.slice(-20);
      await sendFormattedResponse(channel, response, threadTs);
      if (wantsPerformance && thread.repName) await tryAutoSave(response, thread.repName, thread.duration, channel);
    } catch (err) { await sendSlackMessage(channel, '❌ Something went wrong. Try again.', threadTs); }
    return;
  }

  await sendSlackMessage(channel, '⚡ Analysing...', threadTs);
  try {
    const response = await callClaude([{ role: 'user', content: cleanText }]);
    await sendFormattedResponse(channel, response, threadTs);
  } catch (err) { await sendSlackMessage(channel, '❌ Something went wrong. Try again.', threadTs); }
}

// ============================================================
// EXPRESS ROUTES
// ============================================================

app.get('/', (req, res) => res.send('SetryX AI Bot is running ✅'));

app.post('/test/daily-report', (req, res) => {
  res.send('OK');
  postDailyReport().catch(console.error);
});

app.post('/test/inactivity', (req, res) => {
  res.send('OK');
  checkInactivity().catch(console.error);
});

app.post('/slack/events', async (req, res) => {
  try {
    const payload = req.body;
    if (payload.type === 'url_verification') { res.json({ challenge: payload.challenge }); return; }
    res.sendStatus(200);
    const event = payload.event;
    if (!event) return;
    if (event.type !== 'app_mention' && !(event.type === 'message' && event.thread_ts)) return;
    if (event.bot_id || event.subtype === 'bot_message') return;
    const eventId = payload.event_id || `${event.ts}-${event.channel}`;
    if (processedEvents.has(eventId)) return;
    processedEvents.add(eventId);
    if (processedEvents.size > 1000) { const first = processedEvents.values().next().value; processedEvents.delete(first); }
    processEvent(event).catch(console.error);
  } catch (err) { console.error('Slack event error:', err); res.sendStatus(200); }
});

// ============================================================
// AIRCALL AUTO-POLLING
// ============================================================

const MIN_CALL_DURATION = 4 * 60;
const processedCallIds  = new Set();
const inProgressCallIds = new Set();

async function fetchRecentAircallCalls() {
  return new Promise((resolve) => {
    const auth = Buffer.from(`${AIRCALL_API_ID}:${AIRCALL_API_TOKEN}`).toString('base64');
    const from = Math.floor(Date.now() / 1000) - (30 * 60);
    const req  = https.request({
      hostname: 'api.aircall.io', path: `/v1/calls?started_after=${from}&per_page=25&order=desc`,
      method: 'GET', headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data).calls || []); } catch { resolve([]); } });
    });
    req.on('error', () => resolve([]));
    req.end();
  });
}

async function isCallAlreadyReviewed(callId) {
  if (processedCallIds.has(callId)) return true;
  if (!pool) return false;
  try {
    const result = await pool.query(`SELECT id FROM reviews WHERE aircall_call_id = $1 LIMIT 1`, [callId]);
    if (result.rows.length > 0) { processedCallIds.add(callId); return true; }
  } catch (err) { console.error('DB call check error:', err.message); }
  return false;
}

async function pollAircall() {
  if (!AIRCALL_API_ID || !AIRCALL_API_TOKEN) return;
  try {
    const calls = await fetchRecentAircallCalls();
    for (const call of calls) {
      const callId    = call.id?.toString();
      const duration  = call.duration || 0;
      const status    = call.status || 'unknown';
      const direction = call.direction || 'unknown';
      if (!callId || inProgressCallIds.has(callId)) continue;
      if (status !== 'done' || duration < MIN_CALL_DURATION || direction === 'inbound') { processedCallIds.add(callId); continue; }
      if (await isCallAlreadyReviewed(callId)) continue;
      inProgressCallIds.add(callId);
      autoReviewCall(callId, call).catch(console.error);
    }
  } catch (err) { console.error('Polling error:', err.message); }
}

async function autoReviewCall(callId, callMeta) {
  try {
    const repName  = callMeta.user?.name || callMeta.user?.email?.split('@')[0] || 'Unknown';
    const dur      = callMeta.duration || 0;
    const duration = `${Math.floor(dur / 60)}:${String(dur % 60).padStart(2, '0')}`;
    await new Promise(r => setTimeout(r, 2 * 60 * 1000));
    const { transcript } = await fetchAircallTranscript(callId);
    const response = await callClaude([{ role: 'user', content: `You are SetryX AI. Analyse this call and produce a Performance Review.\n\nCall by: ${repName}\nDuration: ${duration}\nCall ID: ${callId}\n\nFULL TRANSCRIPT:\n${transcript}\n\nPerformance Review` }]);
    await tryAutoSave(response, repName, duration, REVIEW_CHANNEL, callId);
    const scoreMatch   = response.match(/OVERALL(?:\s+CALL)?\s+SCORE:\s*(\d+(?:\.\d+)?)\s*\/\s*10/i) || response.match(/OVERALL:\s*(\d+)\s*\/\s*100/i);
    const verdictMatch = response.match(/ONE LINE SUMMARY[:\s]*\n?([^\n]+)/i);
    const rawScore     = scoreMatch ? parseFloat(scoreMatch[1]) : null;
    const score        = rawScore !== null ? (rawScore > 10 ? Math.round(rawScore / 10) : rawScore) : '?';
    const verdict      = verdictMatch ? verdictMatch[1].trim() : '';
    const summary      = `📞 *Auto Review — ${repName}* | ${duration}\n*Score: ${score}/10* — ${verdict}\n_Full scorecard in thread_ 👇`;
    const mainMsg      = await sendSlackMessageAndGetTs(REVIEW_CHANNEL, summary);
    if (mainMsg) await sendFormattedResponse(REVIEW_CHANNEL, response, mainMsg);
    processedCallIds.add(callId);
    inProgressCallIds.delete(callId);
    console.log(`✅ Auto review complete for ${repName} — call ${callId}`);
  } catch (err) {
    console.error(`❌ Auto review failed for call ${callId}: ${err.message}`);
    inProgressCallIds.delete(callId);
  }
}

function startAircallPolling() {
  setTimeout(() => pollAircall().catch(console.error), 60 * 1000);
  setInterval(() => pollAircall().catch(console.error), 5 * 60 * 1000);
  console.log('Aircall polling started — every 5 minutes.');
}

// ============================================================
// START SERVER
// ============================================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SetryX AI Bot running on port ${PORT}`);
  setTimeout(() => {
    try { startAircallPolling(); startSchedulers(); }
    catch (err) { console.error('Failed to start services:', err.message); }
  }, 5000);
});

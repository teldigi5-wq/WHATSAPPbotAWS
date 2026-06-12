const makeWASocket   = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, jidNormalizedUser } = require('@whiskeysockets/baileys');
const qrcode     = require('qrcode');
const fs         = require('fs');
const path       = require('path');
const express    = require('express');
const P          = require('pino');

// ─── CATCH ALL UNHANDLED ERRORS ───────────────────────────────────────────────
process.on('uncaughtException',  e => console.error('💥 uncaughtException:', e));
process.on('unhandledRejection', e => console.error('💥 unhandledRejection:', e));

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const PORT        = process.env.PORT || 8080;
// Your number — plain digits, no @s.whatsapp.net
const SUPER_ADMIN = process.env.SUPER_ADMIN || '94772197530';
const SUPER_ADMIN_LIDS = ['20985227042855'];


async function callGroq(model, question, sys, history, maxTokens) {
    const key = process.env.GROQ_API_KEY || '';
    if (!key) throw new Error('No Groq key');
    const messages = [{ role: 'system', content: sys }];
    if (history && history.length > 0) {
        messages.push(...history.slice(-8));
    } else {
        messages.push({ role: 'user', content: question });
    }
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {'Content-Type':'application/json','Authorization':'Bearer '+key},
        body: JSON.stringify({ model, max_tokens: maxTokens || 900, messages, temperature: 0.7 })
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error.message||JSON.stringify(d.error));
    return d?.choices?.[0]?.message?.content || 'No answer.';
}

const AI_PROVIDERS = {
    gemini: { name: 'Google Gemma 2', emoji: '🟦', call: async (q,s,h,mt) => callGroq('llama-3.1-8b-instant', q, s, h, mt) },
    llama:  { name: 'Llama 3.3 70B',  emoji: '🦙', call: async (q,s,h,mt) => callGroq('llama-3.3-70b-versatile', q, s, h, mt) },
    mistral:{ name: 'Mistral Saba',   emoji: '⚡', call: async (q,s,h,mt) => callGroq('mistral-saba-24b', q, s, h, mt) },
    deepseek:{ name: 'DeepSeek R1',   emoji: '🔬', call: async (q,s,h,mt) => callGroq('deepseek-r1-distill-llama-70b', q, s, h, mt) }
};
function getAIProvider(jid) {
    const p = db.aiProvider && db.aiProvider[jid];
    if (p && AI_PROVIDERS[p]) return p;
    return 'llama';
} // LID fallback for super admin

// Bot credit shown at the bottom of every reply
const BOT_FOOTER = [
    ``,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `🤖 *Created by Poojana Kaveesh*`,
    `🆔 IT26101524  |  📱 94772197530`,
].join('\n');

// ─── LOAD STUDENTS DATA ───────────────────────────────────────────────────────
let STUDENTS = {};
try {
    STUDENTS = require('./students.json');
    console.log(`📚 Students loaded: ${Object.keys(STUDENTS).length}`);
} catch(e) {
    console.error('❌ students.json not found:', e.message);
}

// ─── LOAD TIMETABLE DATA ──────────────────────────────────────────────────────
let TIMETABLE = {};
try {
    TIMETABLE = require('./timetable.json');
    console.log(`📅 Timetable loaded: ${Object.keys(TIMETABLE).length} groups`);
} catch(e) {
    console.warn('⚠️  timetable.json not found — TIMETABLE command will be unavailable');
}

// ─── STATE ────────────────────────────────────────────────────────────────────
let latestQR  = null;
let botReady  = false;
let botStatus = 'starting';
let sock      = null;
let reconnectAttempts = 0;
let qrAttempts        = 0;
let sessionStableAt  = 0;   // timestamp when session is considered stable
let DATA_PATH = '/tmp/botdata';
let AUTH_PATH = '/tmp/botdata/auth';
let DB_PATH   = '/tmp/botdata/database.json';

// ─── STORE STUB + LID RESOLUTION ─────────────────────────────────────────────
// makeInMemoryStore removed in newer Baileys — use a lightweight stub.
const store = { contacts: {}, loadMessage: async () => null, bind: () => {} };

// LID → phone JID map, populated from contacts.upsert events
const lidToPhone = new Map();
const aiConversations = new Map();
const quizSessions = new Map(); // jid → { question, answer, category, asked }

// ─── EAC GROUPING DATA (English for Academic Communication) ─────────────────
const EAC_GROUPS = {"IT25101376":"01A","IT26101585":"01A","IT26100489":"01A","IT26102176":"01A","IT26101615":"01A","IT26101987":"01A","IT26101590":"01A","IT26102097":"01A","IT26102008":"01A","IT26101409":"01A","IT26101393":"01A","IT26101328":"01A","IT26102047":"01A","IT26101657":"01A","IT26101358":"01A","IT26102042":"01A","IT26101614":"01A","IT26101675":"01A","IT26101571":"01A","IT26101737":"01A","IT26101238":"01A","IT26101610":"01A","IT26101602":"01A","IT26101600":"01A","IT26101204":"01A","IT26101744":"01A","IT26101467":"01A","IT26101576":"01A","IT26101805":"01A","IT26101797":"01A","IT26100013":"01A","IT26101901":"01B","IT26101607":"01B","IT26101332":"01B","IT26101985":"01B","IT26102103":"01B","IT26300138":"01B","IT26101228":"01B","IT26101260":"01B","IT26101579":"01B","IT26101284":"01B","IT26101331":"01B","IT26101673":"01B","IT26101992":"01B","IT26102059":"01B","IT26101620":"01B","IT26102002":"01B","IT26101235":"01B","IT26101241":"01B","IT26101629":"01B","IT26200849":"01B","IT26102055":"01B","IT26101893":"01B","IT26101444":"01B","IT26102037":"01B","IT26102018":"01B","IT26101384":"01B","IT26102004":"01B","IT26101589":"01B","IT26101455":"01B","IT26101880":"01B","IT26101333":"01C","IT26101700":"01C","IT26102045":"01C","IT26100956":"01C","IT26101323":"01C","IT26102105":"01C","IT26101691":"01C","IT26101262":"01C","IT26101316":"01C","IT26100944":"01C","IT26101626":"01C","IT26101236":"01C","IT26101237":"01C","IT26101983":"01C","IT26101674":"01C","IT26101688":"01C","IT26101443":"01C","IT26101678":"01C","IT26102031":"01C","IT26100212":"01C","IT26101448":"01C","IT26101651":"01C","IT26101245":"01C","IT26101704":"01C","IT26101990":"01C","IT26101259":"01C","IT26101611":"01C","IT26101642":"01C","IT26101244":"01D","IT26101888":"01D","IT26101129":"01D","IT26101643":"01D","IT26101210":"01D","IT26102104":"01D","IT26101507":"01D","IT26101266":"01D","IT26102041":"01D","IT26101682":"01D","IT26101597":"01D","IT26101672":"01D","IT26102102":"01D","IT26101680":"01D","IT26101697":"01D","IT26101291":"01D","IT26101242":"01D","IT26101454":"01D","IT26101738":"01D","IT26101632":"01D","IT26101997":"01D","IT26101972":"01D","IT26100573":"01D","IT26101367":"02A","IT26101382":"02A","IT26101318":"02A","IT26102144":"02A","IT26101742":"02A","IT26101363":"02A","IT26101512":"02A","IT26101898":"02A","IT26101530":"02A","IT26101522":"02A","IT26101484":"02A","IT26101892":"02A","IT26101735":"02A","IT26101912":"02A","IT26101523":"02A","IT26101946":"02A","IT26101247":"02A","IT26101432":"02A","IT26101301":"02A","IT26101870":"02A","IT26102015":"02A","IT26102107":"02A","IT26102076":"02A","IT26101430":"02A","IT26102017":"02A","IT26102023":"02A","IT26101365":"02A","IT26101490":"02A","IT26101268":"02A","IT26101250":"02A","IT26100718":"02B","IT26101955":"02B","IT26102116":"02B","IT26200228":"02B","IT26101524":"02B","IT26101962":"02B","IT26101628":"02B","IT26101324":"02B","IT26101353":"02B","IT26101801":"02B","IT26102141":"02B","IT26101531":"02B","IT26101889":"02B","IT26101453":"02B","IT26101964":"02B","IT26101658":"02B","IT26101369":"02B","IT26101370":"02B","IT26101319":"02B","IT26101225":"02B","IT26101340":"02B","IT26101337":"02B","IT26101942":"02B","IT26101427":"02B","IT26101469":"02B","IT26101789":"02B","IT26101230":"02B","IT26101953":"02B","IT26101344":"02B","IT26101465":"02B","IT26101639":"02C","IT26101660":"02C","IT26101456":"02C","IT26101285":"02C","IT26101275":"02C","IT26101806":"02C","IT26101528":"02C","IT26101533":"02C","IT26101956":"02C","IT26102112":"02C","IT26101570":"02C","IT26101214":"02C","IT26101223":"02C","IT26101401":"02C","IT26102106":"02C","IT26101313":"02C","IT26101787":"02C","IT26101802":"02C","IT26102113":"02C","IT26101295":"02C","IT26102110":"02C","IT26102108":"02C","IT26101479":"02C","IT26102012":"02C","IT26101716":"02C","IT26101272":"02C","IT26101277":"02C","IT26102114":"02C","IT26102039":"02C","IT26101525":"02D","IT26101520":"02D","IT26101513":"02D","IT26101351":"02D","IT26102115":"02D","IT26101299":"02D","IT26101334":"02D","IT26102150":"02D","IT26101470":"02D","IT26101438":"02D","IT26101421":"02D","IT26101809":"02D","IT26101526":"02D","IT26101482":"02D","IT26102149":"02D","IT26102065":"02D","IT26101822":"02D","IT26101491":"02D","IT26101480":"02D","IT26101349":"02D","IT26102046":"02D","IT26102109":"02D","IT26101362":"02D","IT26101496":"02D","IT26101750":"02D","IT26101212":"02D","IT26102030":"02D","IT26101508":"02D","IT26101795":"02D","IT26101372":"03A","IT26101293":"03A","IT26101646":"03A","IT26101618":"03A","IT26102021":"03A","IT26101966":"03A","IT26101720":"03A","IT26101891":"03A","IT26100262":"03A","IT26102019":"03A","IT26101996":"03A","IT26101968":"03A","IT26101662":"03A","IT26101420":"03A","IT26101355":"03A","IT26101303":"03A","IT26101655":"03A","IT26101568":"03A","IT26101932":"03A","IT26101373":"03A","IT26102003":"03A","IT26101488":"03A","IT26101919":"03A","IT26101248":"03A","IT26101900":"03A","IT26101941":"03A","IT26101950":"03A","IT26101604":"03A","IT26101389":"03A","IT26101812":"03A","IT26102142":"03B","IT26101917":"03B","IT26101743":"03B","IT26101696":"03B","IT26101935":"03B","IT26101954":"03B","IT26100693":"03B","IT26101622":"03B","IT26102034":"03B","IT26101690":"03B","IT26101770":"03B","IT26102058":"03B","IT26101428":"03B","IT26102032":"03B","IT26101631":"03B","IT26101929":"03B","IT26101322":"03B","IT26101807":"03B","IT26101573":"03B","IT26101361":"03B","IT26101577":"03B","IT26200749":"03B","IT26101297":"03B","IT26102127":"03B","IT26101599":"03B","IT26450013":"03B","IT26101414":"03B","IT26101958":"03B","IT26101498":"03B","IT26101398":"03B","IT26101412":"03C","IT26101984":"03C","IT26101908":"03C","IT26101417":"03C","IT26101474":"03C","IT26300323":"03C","IT26101625":"03C","IT26101410":"03C","IT26100543":"03C","IT26101725":"03C","IT26101406":"03C","IT26101635":"03C","IT26101364":"03C","IT26101429":"03C","IT26102075":"03C","IT26101803":"03C","IT26101582":"03C","IT26101653":"03C","IT26101377":"03C","IT26101978":"03C","IT26101203":"03C","IT26101796":"03C","IT26101936":"03C","IT26102111":"03C","IT26101904":"03C","IT26101825":"03C","IT26101913":"03C","IT26101494":"03C","IT26101613":"03C","IT26101823":"03D","IT26102143":"03D","IT26101400":"03D","IT26101434":"03D","IT26101980":"03D","IT26101986":"03D","IT26100739":"03D","IT26102048":"03D","IT26100407":"03D","IT26102148":"03D","IT26101317":"03D","IT26101883":"03D","IT26101925":"03D","IT26101379":"03D","IT26101606":"03D","IT26101909":"03D","IT26101619":"03D","IT26101595":"03D","IT26101376":"03D","IT26101882":"03D","IT26101767":"03D","IT26101937":"03D","IT26101222":"03D","IT26101475":"04A","IT26101396":"04A","IT26101307":"04A","IT26101495":"04A","IT26101407":"04A","IT26101995":"04A","IT26101464":"04A","IT26101722":"04A","IT26100189":"04A","IT26101793":"04A","IT26101258":"04A","IT26101719":"04A","IT26101306":"04A","IT26101617":"04A","IT26101342":"04A","IT26101765":"04A","IT26101300":"04A","IT26101752":"04A","IT26101263":"04A","IT26101305":"04A","IT26101276":"04A","IT26101685":"04A","IT26101397":"04A","IT26101450":"04B","IT26101267":"04B","IT26101753":"04B","IT26101418":"04B","IT26101745":"04B","IT26101694":"04B","IT26101755":"04B","IT26101442":"04B","IT26101817":"04B","IT26100122":"04B","IT26101776":"04B","IT26101451":"04B","IT26101575":"04B","IT26102182":"04B","IT26102196":"04B","IT26101288":"04B","IT26101385":"04B","IT26101760":"04B","IT26101304":"04B","IT26101723":"04B","IT26101633":"04B","IT26101458":"04B","IT26101290":"04B","IT26101375":"04B","IT26101492":"04B","IT26101477":"04B","IT26102178":"04B","IT26102188":"04B","IT26102232":"04B","IT26101423":"04C","IT26101729":"04C","IT26101387":"04C","IT26101289":"04C","IT26101926":"04C","IT26101298":"04C","IT26101730":"04C","IT26101309":"04C","IT26102101":"04C","IT26102190":"04C","IT26102197":"04C","IT26102212":"04C","IT26101965":"04C","IT26101875":"04D","IT26101785":"04D","IT26101327":"04D","IT26101483":"04D","IT26101281":"04D","IT26101366":"04D","IT26101747":"04D","IT26101532":"04D","IT26101708":"04D","IT26101749":"04D","IT26101759":"04D","IT26101764":"04D","IT26101758":"04D","IT26101310":"04D"};
const AI_SESSION_TIMEOUT = 30 * 60 * 1000;
setInterval(() => {
    const now = Date.now();
    for (const [jid, s] of aiConversations) {
        if (now - s.lastActivity > AI_SESSION_TIMEOUT) aiConversations.delete(jid);
    }
}, 10 * 60 * 1000);

/**
 * Resolve a @lid JID to its real @s.whatsapp.net phone JID.
 * WhatsApp now uses @lid JIDs in some regions — we map them on contacts sync.
 * Falls back to replying directly to the @lid JID, which WhatsApp also accepts.
 */
async function resolveLID(jid) {
    if (!jid) return jid;
    if (!jid.endsWith('@lid')) return jid;

    // 1. Check our LID→phone map (built from contacts.upsert)
    if (lidToPhone.has(jid)) {
        const phone = lidToPhone.get(jid);
        console.log(`🔁 LID resolved: ${jid} → ${phone}`);
        return phone;
    }

    // 2. Try jidNormalizedUser
    try {
        const normalized = jidNormalizedUser(jid);
        if (normalized && !normalized.endsWith('@lid')) {
            console.log(`🔁 LID normalized: ${jid} → ${normalized}`);
            lidToPhone.set(jid, normalized); // cache it
            return normalized;
        }
    } catch(_) {}

    // 3. Reply directly to @lid — WhatsApp accepts it
    console.warn(`⚠️  LID unresolved: ${jid} — replying to LID directly`);
    return jid;
}

// Message deduplication: track recently processed message IDs
// Map of msgId → expiry timestamp; swept every 30s (no per-message timers)
const processedMsgIds = new Map();
const DEDUP_TTL = 60000; // 60s
setInterval(() => {
    const now = Date.now();
    for (const [id, exp] of processedMsgIds) {
        if (now > exp) processedMsgIds.delete(id);
    }
}, 30000);

// ─── TWO-LANE SEND SYSTEM ────────────────────────────────────────────────────
//
//  LANE A — Direct replies (priority):
//    • Bypasses the broadcast queue entirely
//    • Sends immediately with up to 3 retries and 1s backoff
//    • Used for all user/admin replies
//
//  LANE B — Broadcast queue (background):
//    • Processes bulk sends at safe rate (800ms/msg)
//    • Never blocks Lane A
//
// This means your personal replies are ALWAYS instant, even during a broadcast.

/**
 * Lane A: direct send with retry. Used for all replies.
 * Never queued — sends immediately.
 */
async function directSend(jid, content, retries = 4) {
    if (!sock) {
        console.error(`❌ directSend: sock is null — bot not connected`);
        throw new Error('sock is null');
    }
    // Wait if session just reconnected (crypto handshake needs time)
    const msSinceStable = Date.now() - sessionStableAt;
    if (msSinceStable < 3000 && msSinceStable >= 0) {
        await sleep(3000 - msSinceStable);
    }
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await throttledSend(jid, content);
        } catch(e) {
            const isLast = attempt === retries;
            if (isLast) {
                console.error(`❌ directSend failed after ${retries} retries to ${jidNum(jid)}: ${e.message}`);
                throw e;
            }
            // Exponential backoff: 1s, 2s, 4s, 8s
            const backoff = 1000 * Math.pow(2, attempt);
            console.warn(`⚠️  directSend attempt ${attempt + 1} failed: ${e.message} — retrying in ${backoff/1000}s`);
            await sleep(backoff);
        }
    }
}

/**
 * Lane B: broadcast queue. Low-priority bulk sends.
 */
const broadcastQueue = [];
let broadcastRunning = false;

function enqueueBroadcast(jid, content) {
    return new Promise((resolve, reject) => {
        broadcastQueue.push({ jid, content, resolve, reject, retries: 0 });
        if (!broadcastRunning) runBroadcastQueue();
    });
}

async function runBroadcastQueue() {
    if (broadcastRunning) return;
    broadcastRunning = true;
    while (broadcastQueue.length > 0) {
        const job = broadcastQueue.shift();
        try {
            const result = await sock.sendMessage(job.jid, job.content);
            job.resolve(result);
        } catch(e) {
            if (job.retries < 3) {
                job.retries++;
                broadcastQueue.unshift(job);
                // Exponential backoff: 5s, 10s, 20s between retries
                await sleep(5000 * job.retries);
            } else {
                job.reject(e);
            }
        }
        // 1200ms + jitter between broadcast sends — safe anti-ban rate
        await sleep(1200 + Math.floor(Math.random() * 300));
    }
    broadcastRunning = false;
}

// ─── DATABASE SCHEMA ──────────────────────────────────────────────────────────
let db = {
    registrations: {},   // jid → "IT26XXXXXX"
    students:      {},   // "IT26XXXXXX" → { ...data, whatsapp, registeredAt, wa_group_slot }
    admins:        [],
    banned:        [],
    broadcasts:    [],
    waGroups:      {},   // slot_key → { jid, inviteLink, name, createdAt }
    projectGroups: {},   // project_group → { members: ["IT26XXXXXX", ...], addedBy, createdAt }
};

// ─── WEB SERVER ───────────────────────────────────────────────────────────────
const app = express();

app.get('/health', (_, res) =>
    res.status(200).json({
        status: botStatus,
        ready: botReady,
        registered: Object.keys(db.registrations).length,
        groups: Object.keys(db.waGroups).length,
    })
);

app.get('/', (_, res) => {
    if (latestQR) {
        qrcode.toDataURL(latestQR, (err, url) => {
            if (err) return res.status(500).send('QR error');
            res.send(`<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Scan QR – SLIIT Bot</title>
<style>
body{font-family:sans-serif;display:flex;flex-direction:column;align-items:center;
justify-content:center;min-height:100vh;margin:0;background:#f0f2f5;padding:20px;box-sizing:border-box;}
h1{color:#128C7E;margin-bottom:4px;}
img{border:4px solid #128C7E;border-radius:8px;max-width:300px;width:100%;}
p{color:#555;font-size:14px;text-align:center;}
.divider{margin:20px 0;color:#aaa;font-size:13px;}
.pair-box{background:#fff;border-radius:12px;padding:20px;box-shadow:0 2px 8px rgba(0,0,0,.1);text-align:center;max-width:320px;width:100%;}
input{padding:10px;border:1px solid #ccc;border-radius:8px;font-size:16px;width:100%;box-sizing:border-box;margin:8px 0;}
button{background:#128C7E;color:#fff;border:none;padding:12px 24px;border-radius:8px;font-size:15px;cursor:pointer;width:100%;}
button:hover{background:#0f7167;}
#result{margin-top:12px;font-size:15px;font-weight:bold;}
small{color:#888}
</style></head><body>
<h1>📱 SLIIT Bot Login</h1>
<div class="pair-box">
  <p><b>Option 1: Scan QR</b><br>WhatsApp → Linked Devices → Link a Device</p>
  <img src="${url}" alt="QR Code">
  <p><small>Auto-refresh in 30s</small></p>
  <script>setTimeout(()=>location.reload(),30000)</script>

  <div class="divider">── OR ──</div>

  <p><b>Option 2: Pair with Phone Number</b><br>Enter the bot's WhatsApp number:</p>
  <input id="phone" type="tel" placeholder="e.g. 94761297530" value="">
  <button onclick="pair()">Get Pairing Code</button>
  <div id="result"></div>
</div>
<p><small>Created by Poojana Kaveesh | IT26101524</small></p>
<script>
async function pair() {
  const phone = document.getElementById('phone').value.replace(/[^0-9]/g,'');
  const res = document.getElementById('result');
  if (!phone || phone.length < 7) { res.textContent = '❌ Enter a valid number'; res.style.color='red'; return; }
  res.textContent = '⏳ Requesting code...'; res.style.color='#555';
  try {
    const r = await fetch('/pair?phone=' + phone);
    const d = await r.json();
    if (d.code) {
      res.innerHTML = '✅ Your pairing code:<br><span style="font-size:28px;letter-spacing:4px;color:#128C7E">' + d.code + '</span><br><small>WhatsApp → Linked Devices → Link with Phone Number</small>';
    } else {
      res.textContent = '❌ ' + (d.error || 'Failed'); res.style.color='red';
    }
  } catch(e) { res.textContent = '❌ Request failed'; res.style.color='red'; }
}
</script>
</body></html>`);
        });
    } else {
        const slotCount = Object.keys(db.waGroups || {}).length;
        res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>SLIIT Bot</title>
<meta http-equiv="refresh" content="8">
<style>body{font-family:sans-serif;text-align:center;padding:60px;background:#f0f2f5;}
h1{color:${botReady?'#128C7E':'#888'}}</style></head>
<body><h1>${botReady ? '✅ Bot Online' : '⏳ Starting...'}</h1>
<p>Status: <b>${botStatus}</b> | Registered: <b>${Object.keys(db.registrations).length}</b> | WA Group Slots: <b>${slotCount}</b></p>
<p>Data: <b>${DATA_PATH}</b></p>
<p><small>Created by Poojana Kaveesh | IT26101524 | 94772197530</small></p>
</body></html>`);
    }
});

// Pairing code endpoint — GET /pair?phone=94761297530
app.get('/pair', async (req, res) => {
    const phone = (req.query.phone || '').replace(/[^0-9]/g, '');
    if (!phone) return res.json({ error: 'Missing phone number' });
    if (!sock)  return res.json({ error: 'Bot not connected yet — wait for QR page to show, then try again' });
    if (botStatus === 'ready') return res.json({ error: 'Already linked — bot is online' });
    try {
        const code = await sock.requestPairingCode(phone);
        console.log(`🔑 Pairing code for ${phone}: ${code}`);
        res.json({ code });
    } catch(e) {
        console.error('Pairing code error:', e.message);
        res.json({ error: e.message });
    }
});

const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 HTTP on port ${PORT}`);
    initData();
});
server.on('error', e => { console.error('💥 HTTP error:', e.message); process.exit(1); });

// ─── INIT DATA ────────────────────────────────────────────────────────────────
function initData() {
    DATA_PATH = resolveDataPath();
    AUTH_PATH = path.join(DATA_PATH, 'auth');
    DB_PATH   = path.join(DATA_PATH, 'database.json');
    try {
        const credsFile = path.join(AUTH_PATH, 'creds.json');
        const files = fs.readdirSync(AUTH_PATH);
        if (files.length > 0 && !fs.existsSync(credsFile)) {
            console.log('🧹 Partial auth — clearing');
            fs.rmSync(AUTH_PATH, { recursive: true, force: true });
        } else if (files.length > 0) {
            console.log('🔑 Auth session found — resuming');
        }
    } catch(_) {}
    fs.mkdirSync(AUTH_PATH, { recursive: true });
    loadDB();
    setTimeout(startBot, 1000);
}

function resolveDataPath() {
    const candidates = [
        process.env.DATA_PATH,
        process.env.RAILWAY_VOLUME_MOUNT_PATH,
        '/data', '/vol', '/mnt/data', '/app/data',
    ].filter(Boolean);
    for (const p of candidates) {
        try {
            fs.mkdirSync(p, { recursive: true });
            const t = path.join(p, '.writetest');
            fs.writeFileSync(t, '1'); fs.unlinkSync(t);
            console.log(`💾 Data path: ${p}`);
            return p;
        } catch(_) { console.log(`⏭️  Not writable: ${p}`); }
    }
    console.warn('⚠️  Falling back to /tmp — data will NOT persist!');
    fs.mkdirSync('/tmp/botdata', { recursive: true });
    return '/tmp/botdata';
}

function loadDB() {
    try {
        if (fs.existsSync(DB_PATH)) {
            const saved = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
            db = { ...db, ...saved };
            if (!db.waGroups)      db.waGroups      = {};
            if (!db.projectGroups) db.projectGroups = {};
            if (!db.admins)        db.admins        = [];
            if (!db.banned)        db.banned        = [];
            if (!db.broadcasts)    db.broadcasts    = [];
            if (!db.languages)     db.languages     = {};
            if (!db.aiProvider)    db.aiProvider    = {};
            if (!db.groupLinks)    db.groupLinks    = {};
            if (!db.aiSessions)    db.aiSessions    = {};
            console.log(`📦 DB loaded — ${Object.keys(db.registrations).length} registrations, ${Object.keys(db.waGroups).length} WA groups`);
        }
    } catch(e) { console.error('DB load error:', e.message); }
}

// Atomic write: write to temp file, then rename to avoid corruption
function saveDB() {
    try {
        const tmp = DB_PATH + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
        fs.renameSync(tmp, DB_PATH);
    } catch(e) { console.error('DB save error:', e.message); }
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
const jidNum       = jid => (jid || '').replace(/@.*/, '').replace(/[^0-9]/g, '');
const toJid        = num => `${num.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
const isSuperAdmin = jid => {
    if (SUPER_ADMIN_LIDS.includes(jidNum(jid))) return true;
    if (jidNum(jid) === jidNum(SUPER_ADMIN)) return true;
    return false;
};
const isAdmin      = jid => isSuperAdmin(jid) || db.admins.some(a => jidNum(a) === jidNum(jid));
const isBanned     = jid => db.banned.some(b => jidNum(b) === jidNum(jid));
const nowISO       = () => new Date().toISOString();
const isGroup      = jid => (jid || '').endsWith('@g.us');
const sleep        = ms => new Promise(r => setTimeout(r, ms));

function lookupStudent(itArg) {
    const key = itArg.toUpperCase().startsWith('IT')
        ? itArg.toUpperCase() : 'IT' + itArg.toUpperCase();
    return { key, data: STUDENTS[key] || null };
}

function fmtStudent(reg, info) {
    const weekend = info.timetable_group.includes('WE');
    return [
        `╔══════════════════════════╗`,
        `  📋 *Student Information*`,
        `╚══════════════════════════╝`,
        ``,
        `🆔 *Reg No:*       ${reg}`,
        `👤 *Name:*         ${info.name}`,
        `📅 *Semester:*     Year 01 – Sem 01`,
        `                   (Jul–Dec 2026)`,
        `🗓️  *Schedule:*     ${weekend ? '🌅 Weekend' : '📆 Weekday'}`,
        `📚 *TT Group:*     ${info.timetable_group}`,
        `📌 *Sub Group:*    ${info.sub_group}`,
        `🔢 *Project Grp:*  ${info.project_group}`,
    ].join('\n');
}

// Append the bot footer to every outgoing reply
function withFooter(text) { return text + BOT_FOOTER; }

// ─── LANGUAGE HELPERS ─────────────────────────────────────────────────────────
function getLang(jid) { return (db.languages && db.languages[jid]) || 'en'; }

function timeGreeting(lang) {
    const h = new Date(new Date().toLocaleString('en-US', {timeZone:'Asia/Colombo'})).getHours();
    if (lang === 'si') {
        if (h>=5&&h<12) return '🌅 සුභ උදෑසනක්!';
        if (h>=12&&h<17) return '☀️ සුභ දහවලක්!';
        if (h>=17&&h<21) return '🌆 සුභ සවසක්!';
        return '🌙 සුභ රාත්‍රියක්!';
    }
    if (h>=5&&h<12) return '🌅 Good Morning!';
    if (h>=12&&h<17) return '☀️ Good Afternoon!';
    if (h>=17&&h<21) return '🌆 Good Evening!';
    return '🌙 Good Night!';
}

// ─── MOTIVATIONAL QUOTES ──────────────────────────────────────────────────────
const QUOTES_EN = [
    'The secret of getting ahead is getting started. — Mark Twain',
    'It always seems impossible until it is done. — Nelson Mandela',
    'Do not watch the clock; do what it does. Keep going. — Sam Levenson',
    'The future belongs to those who believe in the beauty of their dreams.',
    'Strive for progress, not perfection.',
    'Your only limit is your mind.',
    'Success is not final, failure is not fatal: it is the courage to continue.',
    'Hard work beats talent when talent does not work hard.',
    'Believe you can and you are halfway there. — Theodore Roosevelt',
    'Every expert was once a beginner. Keep learning!',
    'The best time to study was yesterday. The next best time is now.',
    'Sleep 8 hours, study 8 hours, panic 8 hours — the student life! 😄',
];
const QUOTES_SI = [
    '"ඉදිරියට යාමේ රහස නම් ආරම්භ කිරීමයි."',
    '"කළ නොහැකි බව පෙනෙන්නේ සිදු නොවූ විටය." — Nelson Mandela',
    '"ඔබේ සීමාව ඔබේ මනසයි."',
    '"සාර්ථකත්වය ලැබෙන්නේ අඛණ්ඩ උත්සාහයෙනි."',
    '"ගුරුවරයෙකු නොමැතිව ඉගෙනීම, ශිෂ්‍යයෙකු නොමැතිව ඉගැන්වීම වැනිය."',
    '"අද හෙට කළ යුතු දෙය ගැන සිතන්නෙපා — අද ආරම්භ කරන්න!"',
    '"දැනුම ශක්තියකි. ඉගෙනගන්න, වර්ධනය වන්න!"',
    '"Exam එකට හොඳට ගහමු! 💪"',
];
function randomQuote(lang) {
    const q = lang === 'si' ? QUOTES_SI : QUOTES_EN;
    return q[Math.floor(Math.random() * q.length)];
}

// ─── TIMETABLE HELPERS ────────────────────────────────────────────────────────

function getSLDay(date) {
    const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const slOffset = 5.5 * 60 * 60 * 1000;
    const slDate = new Date(date.getTime() + slOffset);
    return days[slDate.getUTCDay()];
}

function formatDayTimetable(groupKey, dayName, subGroupFilter) {
    const groupTT = TIMETABLE[groupKey];
    if (!groupTT) return null;
    const dayTT = groupTT[dayName];
    if (!dayTT || Object.keys(dayTT).length === 0) return [];

    const lines = [];
    const sortedTimes = Object.keys(dayTT).sort();

    for (const time of sortedTimes) {
        const sessions = dayTT[time];
        for (const session of sessions) {
            if (subGroupFilter && session.subgroup && !session.subgroup.includes(subGroupFilter)) {
                continue;
            }
            const label = session.subgroup ? `[${session.subgroup.split('.').pop()}]` : '';
            lines.push(`⏰ *${time}*${label ? ' ' + label : ''}`);
            lines.push(`   📖 ${session.subject}`);
            if (session.teacher) lines.push(`   👩‍🏫 ${session.teacher}`);
            if (session.room)    lines.push(`   🏫 Room: ${session.room}`);
            lines.push('');
        }
    }
    return lines;
}

/**
 * FIX: Corrected sub-group code calculation.
 * student sub_group: "Y1.S1.WD.IT.02.001" → suffix "001" → subIdx 1
 * timetable sub-group format: "Y1.S1.WD.IT.0201" (group "02" + padded index "01")
 */
function getStudentTodayTimetable(regKey, targetDay) {
    const studentData = STUDENTS[regKey];
    if (!studentData) return null;

    const timetableGroup = studentData.timetable_group; // e.g. "Y1.S1.WD.IT.02"
    const subGroup       = studentData.sub_group;        // e.g. "Y1.S1.WD.IT.02.001"

    // Extract group number: "Y1.S1.WD.IT.02" → "02"
    const groupNum = timetableGroup.split('.').pop(); // "02"

    // Extract sub-group suffix: "Y1.S1.WD.IT.02.001" → "001" → integer 1
    const subGroupSuffix = subGroup.split('.').pop();   // "001"
    const subIdx = parseInt(subGroupSuffix, 10);        // 1

    // Build timetable sub-group code: group "02", sub-index 1 → "Y1.S1.WD.IT.0201"
    const ttSubGroupCode = `${timetableGroup.split('.').slice(0, -1).join('.')}.${groupNum}${String(subIdx).padStart(2, '0')}`;
    // e.g. "Y1.S1.WD.IT" + "." + "0201" → "Y1.S1.WD.IT.0201"

    const lines = formatDayTimetable(timetableGroup, targetDay, ttSubGroupCode);
    return { lines, timetableGroup, ttSubGroupCode };
}

function buildTimetableMessage(regKey, targetDay) {
    if (!Object.keys(TIMETABLE).length) {
        return withFooter('❌ Timetable data not loaded. Contact admin.');
    }

    const result = getStudentTodayTimetable(regKey, targetDay);
    if (!result) return withFooter('❌ Student not found.');

    const { lines, timetableGroup, ttSubGroupCode } = result;
    const studentData = STUDENTS[regKey];
    const isWeekend   = timetableGroup.includes('WE');

    if (isWeekend) {
        return withFooter([
            `📅 *${targetDay} Timetable*`,
            ``,
            `ℹ️ You are in the *Weekend* batch.`,
            `This timetable file only covers weekday groups.`,
            `Please check the Weekend timetable separately.`,
        ].join('\n'));
    }

    const header = [
        `╔═══════════════════════╗`,
        `  📅 *${targetDay.toUpperCase()} TIMETABLE*`,
        `╚═══════════════════════╝`,
        ``,
        `👤 *${studentData.name}*`,
        `📚 Group: ${timetableGroup}`,
        `📌 Sub-group: ${ttSubGroupCode}`,
        ``,
        `━━━━━━━━━━━━━━━━━━━━━━━`,
        ``,
    ];

    if (!lines || lines.length === 0) {
        return withFooter(header.join('\n') + `\n🎉 *No classes today!*\nEnjoy your free day! 🏖️`);
    }

    return withFooter(header.join('\n') + '\n' + lines.join('\n').trimEnd());
}

// ─── GROUP MANAGEMENT ─────────────────────────────────────────────────────────
const MAX_STUDENTS_PER_GROUP = 6;

function registeredCountInSlot(groupSlot) {
    return Object.values(db.students)
        .filter(s => s.wa_group_slot === groupSlot)
        .length;
}

function resolveGroupSlot(projectGroup) {
    const slotKeys = Object.keys(db.waGroups)
        .filter(k => k === projectGroup || k.startsWith(projectGroup + '_'))
        .sort();
    if (slotKeys.length === 0) return projectGroup;
    for (const slot of slotKeys) {
        if (registeredCountInSlot(slot) < MAX_STUDENTS_PER_GROUP) return slot;
    }
    const nextIndex = slotKeys.length + 1;
    return `${projectGroup}_${nextIndex}`;
}

/**
 * FIX: Removed auto-adding SUPER_ADMIN to every group.
 * Groups are created with bot only (sock creates them), then bot promotes itself if needed.
 * SUPER_ADMIN is NOT added as a participant to any student group.
 */
async function getOrCreateWAGroup(slot, projectGroup) {
    if (db.waGroups[slot]) return db.waGroups[slot].jid;
    const isOverflow = slot !== projectGroup;
    const slotSuffix = isOverflow ? ` (${slot.split('_').pop()})` : '';
    const groupName  = `SLIIT Y1S1 – ${projectGroup}${slotSuffix}`;
    console.log(`🏗️  Creating WA group: ${groupName} [slot: ${slot}]`);
    try {
        // Create group with only bot account — NO SUPER_ADMIN added
        const result = await sock.groupCreate(groupName, []);
        const gid = result.id;

        let inviteLink = '';
        try {
            const code = await sock.groupInviteCode(gid);
            inviteLink = `https://chat.whatsapp.com/${code}`;
        } catch(e) { console.warn(`⚠️  Could not get invite link for ${slot}:`, e.message); }

        db.waGroups[slot] = { jid: gid, inviteLink, name: groupName, createdAt: nowISO() };
        saveDB();
        console.log(`✅ Group created: ${groupName} → ${gid}`);
        await sleep(1500);
        return gid;
    } catch(e) {
        console.error(`❌ Failed to create group ${slot}:`, e.message);
        return null;
    }
}

async function addStudentToGroup(studentJid, projectGroup, regKey) {
    const slot = resolveGroupSlot(projectGroup);
    const gid  = await getOrCreateWAGroup(slot, projectGroup);
    if (!gid) return { ok: false, reason: 'could not create group', slot };
    if (db.students[regKey]) {
        db.students[regKey].wa_group_slot = slot;
        saveDB();
    }
    try {
        const res    = await sock.groupParticipantsUpdate(gid, [studentJid], 'add');
        const status = res?.[0]?.status;
        if (status === 200 || status === 409) {
            console.log(`✅ ${jidNum(studentJid)} added to group ${slot} (status ${status})`);
            return { ok: true, method: status === 409 ? 'already_member' : 'direct_add', slot };
        }
        console.warn(`⚠️  Direct add failed (status ${status}) for ${jidNum(studentJid)}`);
        return await sendGroupInvite(studentJid, slot, gid);
    } catch(e) {
        console.error(`❌ groupParticipantsUpdate error for ${jidNum(studentJid)}:`, e.message);
        return await sendGroupInvite(studentJid, slot, gid);
    }
}

async function sendGroupInvite(studentJid, slot, gid) {
    try {
        let link = db.waGroups[slot]?.inviteLink || '';
        if (!link) {
            const code = await sock.groupInviteCode(gid);
            link = `https://chat.whatsapp.com/${code}`;
            if (db.waGroups[slot]) {
                db.waGroups[slot].inviteLink = link;
                saveDB();
            }
        }
        await directSend(studentJid, {
            text: withFooter(`🔗 *Join your project group (${slot})*\n\n${link}\n\nTap the link above to join your WhatsApp group.`)
        });
        return { ok: true, method: 'invite_link_sent', link, slot };
    } catch(e) {
        console.error(`❌ sendGroupInvite error:`, e.message);
        return { ok: false, reason: e.message, slot };
    }
}

// ─── PENDING GROUP JOIN CONFIRMATIONS ────────────────────────────────────────
// After REG, we ask the student if they want to join the WA project group.
// This map stores { regKey, studentData, expiresAt } keyed by user JID.
const pendingGroupConfirm = new Map();
const CONFIRM_TTL = 5 * 60 * 1000; // 5 minutes to reply YES/NO

// Clean up expired confirmations every 2 minutes
setInterval(() => {
    const now = Date.now();
    for (const [jid, entry] of pendingGroupConfirm) {
        if (entry.expiresAt < now) pendingGroupConfirm.delete(jid);
    }
}, 120000);

/**
 * After REG: send a confirmation question instead of adding immediately.
 * Returns a message string to append to the REG success reply.
 */
async function askGroupJoinConfirmation(studentJid, studentData, regKey) {
    const pg = studentData.project_group;
    pendingGroupConfirm.set(studentJid, {
        regKey,
        studentData,
        expiresAt: Date.now() + CONFIRM_TTL,
    });
    return [
        ``,
        ``,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `📌 *Project Group: ${pg}*`,
        ``,
        `Would you like to be added to your`,
        `*WhatsApp project group* now?`,
        ``,
        `Reply *YES* to join`,
        `Reply *NO* to skip (you can join later via MYGROUPS)`,
    ].join('\n');
}

async function handleGroupJoin(studentJid, studentData, regKey) {
    const pg = studentData.project_group;
    await sleep(500);
    const result = await addStudentToGroup(studentJid, pg, regKey);
    const { slot } = result;
    const groupInfo = slot ? db.waGroups[slot] : null;
    const memberCount = slot ? registeredCountInSlot(slot) : 0;
    const slotDisplay = slot || pg;
    let groupMsg = '';
    if (result.ok) {
        if (result.method === 'direct_add') {
            groupMsg  = `\n\n✅ *Added to your project group!*`;
            groupMsg += `\n📌 Group: *${slotDisplay}*`;
            groupMsg += `\n👥 Members: ${memberCount}/${MAX_STUDENTS_PER_GROUP}`;
            if (groupInfo?.inviteLink) groupMsg += `\n🔗 ${groupInfo.inviteLink}`;
        } else if (result.method === 'already_member') {
            groupMsg  = `\n\n✅ *Already in project group (${slotDisplay})*`;
            groupMsg += `\n👥 Members: ${memberCount}/${MAX_STUDENTS_PER_GROUP}`;
        } else if (result.method === 'invite_link_sent') {
            groupMsg  = `\n\n📨 *Group invite sent for ${slotDisplay}*`;
            groupMsg += `\n👥 Members: ${memberCount}/${MAX_STUDENTS_PER_GROUP}`;
            groupMsg += `\nCheck the message above to join your group.`;
        }
    } else {
        groupMsg = `\n\n⚠️ *Could not add to group ${slotDisplay}* (${result.reason})\nContact admin for the group link.`;
    }
    return groupMsg;
}

// ─── ADMIN MEMBER MANAGEMENT ──────────────────────────────────────────────────
async function adminAddMember(adminJid, regArg, waNumArg, reply) {
    const { key, data } = lookupStudent(regArg);
    if (!data) {
        await reply(withFooter(`❌ Student *${key}* not found in the database.\nCheck the registration number.`));
        return;
    }

    const waNum = waNumArg.replace(/[^0-9]/g, '');
    if (waNum.length < 10) {
        await reply(withFooter(`❌ Invalid WhatsApp number: *${waNumArg}*\nUse format: 94771234567`));
        return;
    }

    const studentJid = toJid(waNum);

    const clash = Object.entries(db.registrations)
        .find(([w, it]) => it === key && jidNum(w) !== waNum);
    if (clash) {
        await reply(withFooter(`⚠️ *${key}* is already registered to number *${jidNum(clash[0])}*.\n\nUse FORCEREG to override.`));
        return;
    }

    db.registrations[studentJid] = key;
    db.students[key] = {
        ...data,
        whatsapp: studentJid,
        registeredAt: db.students[key]?.registeredAt || nowISO(),
        addedBy: jidNum(adminJid),
    };
    saveDB();

    await reply(withFooter(`⏳ Registering *${key}* (${data.name})...\nAdding to project group *${data.project_group}*`));

    const result = await addStudentToGroup(studentJid, data.project_group, key);
    const slot = result.slot;
    const memberCount = slot ? registeredCountInSlot(slot) : 0;

    let msg = [
        `✅ *Member Added Successfully!*`,
        ``,
        `🆔 *Reg No:*   ${key}`,
        `👤 *Name:*     ${data.name}`,
        `📱 *WA Num:*   ${waNum}`,
        `🔢 *Project:*  ${data.project_group}`,
        `📌 *Slot:*     ${slot}`,
        `👥 *Members:*  ${memberCount}/${MAX_STUDENTS_PER_GROUP}`,
    ];
    if (result.ok) {
        msg.push(`✔️ *Status:*   ${result.method === 'direct_add' ? 'Added to group' : result.method === 'already_member' ? 'Already in group' : 'Invite sent'}`);
    } else {
        msg.push(`⚠️ *Status:*  Group add failed — ${result.reason}`);
    }
    await reply(withFooter(msg.join('\n')));

    // Notify the student
    try {
        await directSend(studentJid, {
            text: withFooter([
                `👋 *Welcome to SLIIT Y1S1!*`,
                ``,
                `You've been added to the bot by an admin.`,
                ``,
                fmtStudent(key, data),
                ``,
                `Send *HELP* to see available commands.`,
            ].join('\n'))
        });
    } catch(_) {}
}

async function forceReg(adminJid, regArg, waNumArg, reply) {
    const { key, data } = lookupStudent(regArg);
    if (!data) { await reply(withFooter(`❌ *${key}* not found.`)); return; }

    const waNum = waNumArg.replace(/[^0-9]/g, '');
    if (waNum.length < 10) { await reply(withFooter(`❌ Invalid number: ${waNumArg}`)); return; }

    const studentJid = toJid(waNum);

    for (const [w, it] of Object.entries(db.registrations)) {
        if (it === key) delete db.registrations[w];
    }

    db.registrations[studentJid] = key;
    db.students[key] = {
        ...data,
        ...(db.students[key] || {}),
        whatsapp: studentJid,
        registeredAt: nowISO(),
        addedBy: jidNum(adminJid),
    };
    saveDB();

    await reply(withFooter(`✅ *FORCEREG done*\n${key} → ${waNum}\nNow use ADDTOGROUP ${key} to add them to their group.`));
}

// ─── PER-USER MESSAGE QUEUE ───────────────────────────────────────────────────
// Serializes messages from the same user — prevents race conditions when
// 1000 students message at once. Each user gets their own queue so they
// don't block each other.
const userQueues = new Map();  // jid → Promise (tail of chain)

function enqueueForUser(jid, fn) {
    const prev = userQueues.get(jid) || Promise.resolve();
    const next = prev.then(() => fn()).catch(e => console.error(`❌ queued handler error [${jidNum(jid)}]:`, e.message));
    userQueues.set(jid, next);
    // GC: remove entry once the chain settles
    next.finally(() => { if (userQueues.get(jid) === next) userQueues.delete(jid); });
}

// ─── RATE LIMITER + ANTI-BAN THROTTLE ────────────────────────────────────────
//
//  Anti-ban strategy:
//  • Per-user: max 5 commands per 15s (generous for real students, blocks spammers)
//  • Global outbound: 700ms gap between any two sends (safe for WhatsApp)
//  • Broadcast: 1200ms gap (extra safe for bulk sends)
//  • Admins/super admin: fully exempt from rate limits
//  • Jitter: ±100ms random delay on every send (mimics human typing rhythm)
//
const rateLimitMap = new Map();   // jid → { count, windowStart }
const RATE_LIMIT_MAX    = 5;      // max commands per window per user
const RATE_LIMIT_WINDOW = 15000;  // 15 second window

let lastSentAt = 0;
const MIN_SEND_GAP = 700;         // ms between any two outbound messages

// Add human-like jitter to sends — reduces ban risk
const jitter = () => Math.floor(Math.random() * 100);

function isRateLimited(jid) {
    if (isSuperAdmin(jid) || isAdmin(jid)) return false;
    const now = Date.now();
    let entry = rateLimitMap.get(jid);
    if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW) {
        entry = { count: 1, windowStart: now };
        rateLimitMap.set(jid, entry);
        return false;
    }
    entry.count++;
    if (entry.count > RATE_LIMIT_MAX) {
        console.warn(`🚦 Rate limited: ${jidNum(jid)} (${entry.count} msgs in ${RATE_LIMIT_WINDOW/1000}s)`);
        return true;
    }
    return false;
}

// Clean up stale rate limit entries every 60s
setInterval(() => {
    const cutoff = Date.now() - RATE_LIMIT_WINDOW * 2;
    for (const [jid, entry] of rateLimitMap) {
        if (entry.windowStart < cutoff) rateLimitMap.delete(jid);
    }
}, 60000);

// Throttle outbound sends — enforces MIN_SEND_GAP + jitter globally
async function throttledSend(jid, content) {
    const now = Date.now();
    const wait = (MIN_SEND_GAP + jitter()) - (now - lastSentAt);
    if (wait > 0) await sleep(wait);
    lastSentAt = Date.now();
    return sock.sendMessage(jid, content);
}

// ═══════════════════════════════════════════════════════════════════════════════
// MESSAGE HANDLER
// ═══════════════════════════════════════════════════════════════════════════════
async function handleMessage(rawMsg) {
    try {
        const msg = rawMsg.messages?.[0];
        if (!msg || !msg.key) return;
        if (msg.key.fromMe) return;

        const rawJid = msg.key.remoteJid || '';
        if (rawJid === 'status@broadcast') return;
        if (isGroup(rawJid)) return;

        // Normalize + resolve LID → real phone JID
        const normalizedJid = rawJid.includes('@') ? rawJid : `${rawJid}@s.whatsapp.net`;
        const jid = await resolveLID(normalizedJid);

        // ── Full key dump removed — LID resolution working fine ───────────────
        console.log(`📲 Resolved sender JID: ${jid}`);

        // ── Message deduplication ──────────────────────────────────────────────
        const msgId = msg.key.id;
        if (msgId) {
            if (processedMsgIds.has(msgId)) return;
            processedMsgIds.set(msgId, Date.now() + DEDUP_TTL);
        }

        const body =
            msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            msg.message?.buttonsResponseMessage?.selectedDisplayText ||
            msg.message?.listResponseMessage?.title || '';

        if (!body || !body.trim()) return;
        const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        const quotedText = quotedMsg?.conversation || quotedMsg?.extendedTextMessage?.text || '';
        const isReplyToAI = quotedText.includes('Assistant') || quotedText.includes('Answer:') || quotedText.includes('සහායක') || quotedText.includes('Turn ');

        const ts = Number(msg.messageTimestamp) * 1000;
        if (Date.now() - ts > 600000) return;  // skip messages older than 10 min (covers Railway deploy time)

        if (!botReady) {
            console.log(`⏸  Bot not ready (${botStatus}) — ignoring ${jidNum(jid)}`);
            return;
        }

        // Rate limit check — drop silently if exceeded (no reply to avoid further sends)
        if (isRateLimited(jid)) return;

        // Touch activity watchdog + dispatch to per-user queue
        touchActivity();
        enqueueForUser(jid, () => processMessage(jid, msg, body));

    } catch(e) {
        console.error(`❌ handleMessage error: ${e.message}`, e.stack);
    }
}

async function processMessage(jid, msg, body) {
        const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        const quotedText = quotedMsg?.conversation || quotedMsg?.extendedTextMessage?.text || '';
        const isReplyToAI = quotedText.includes('Answer:') || quotedText.includes('Turn') || quotedText.includes('Assistant') || quotedText.includes('සහායක');
    try {
        const sid = jid;
        // reply — Lane A (direct, instant, retries 3x)
        const reply = async (text) => {
            console.log(`📤 Sending reply to ${jidNum(sid)} (${text.length} chars)`);
            try {
                await directSend(sid, { text });
                console.log(`✅ Reply sent to ${jidNum(sid)}`);
            } catch(e) {
                console.error(`❌ reply FAILED to ${jidNum(sid)}: ${e.message}\n${e.stack}`);
            }
        };

        const parts = body.trim().split(/\s+/);
        const cmd   = parts[0].replace(/^\//, '').toUpperCase();
        const arg1  = parts[1] || '';
        const arg2  = parts[2] || '';
        const rest  = parts.slice(1).join(' ');

        console.log(`📨 ${jidNum(jid)} → ${body.trim().slice(0, 80)}`);

        if (isBanned(sid)) { console.log(`🚫 Banned user: ${jidNum(sid)}`); return; }

        // ── QUIZ ANSWER HANDLER — captures the reply to an active quiz ───────────
        if (quizSessions.has(sid) && !['QUIZ','PRACTICE','Q','MYEAC','EAC','ASK','AI','HELP','HI','HELLO','START','MENU','MYINFO','SETAI','USEAI','ENDCHAT','LANG'].includes(cmd)) {
            const qs = quizSessions.get(sid);
            const userAns = body.trim();
            const lang = getLang(sid);
            quizSessions.delete(sid);
            const prov = AI_PROVIDERS[getAIProvider(sid)];
            await reply(withFooter(`⏳ *Checking your answer...*`));
            try {
                const checkPrompt = `Quiz Question: "${qs.question}"
Correct Answer: "${qs.answer}"
Student's Answer: "${userAns}"
Category: ${qs.category}

Evaluate if the student's answer is correct (accept reasonable variations).
Reply in this exact format:
RESULT: CORRECT or WRONG
EXPLANATION: [2-3 sentences explaining why the answer is correct/wrong, what the right answer is, and a helpful tip]`;
                const result = await prov.call(checkPrompt, 'You are a strict but encouraging teacher. Evaluate student answers fairly.', [], 350);
                const isCorrect = result.toUpperCase().includes('RESULT: CORRECT');
                const explanation = result.replace(/RESULT:[^\n]*/i, '').replace(/EXPLANATION:/i, '').trim();
                const emoji = isCorrect ? '✅' : '❌';
                const feedback = isCorrect
                    ? (lang==='si' ? '🎉 *නිවැරදියි!*' : '🎉 *Correct! Well done!*')
                    : (lang==='si' ? `❌ *වැරදියි.*\n\n✅ *නිවැරදි පිළිතුර:* ${qs.answer}` : `❌ *Not quite right.*\n\n✅ *Correct answer:* ${qs.answer}`);
                await reply(withFooter([
                    `${emoji} *Quiz Result*`,
                    ``,
                    `❓ *Question:* ${qs.question}`,
                    `💬 *Your answer:* ${userAns}`,
                    ``,
                    feedback,
                    ``,
                    `📖 *Explanation:*`,
                    explanation,
                    ``,
                    `_Send *QUIZ* for another question!_`,
                ].join('\n')));
            } catch(e) {
                console.error('Quiz check error:', e.message);
                await reply(withFooter(`❌ Could not check your answer. Try sending *QUIZ* for a new question.`));
            }
            return;
        }

        // ── ENDCHAT ───────────────────────────────────────────────────────
        if (body.trim().toUpperCase() === 'ENDCHAT') {
            const lang = getLang(sid);
            if (aiConversations.has(sid)) {
                const turns = Math.floor((aiConversations.get(sid).history?.length||0)/2);
                aiConversations.delete(sid);
                await reply(withFooter(lang==='si'
                    ? `✅ *AI සංවාදය අවසන්!*
📊 ප්‍රශ්න ${turns}ක් .
නව: *ASK <ප්‍රශ්නය>*`
                    : `✅ *AI chat ended!*
📊 ${turns} question(s) asked.
New session: *ASK <question>*`
                ));
            } else {
                await reply(withFooter(lang==='si' ? '⚠️ සක්‍රිය AI සංවාදයක් නොමැත.' : '⚠️ No active AI session.'));
            }
            return;
        }

        // ── AI REPLY CONTINUATION ─────────────────────────────────────────────
        if (isReplyToAI && body.trim() && cmd !== 'ASK' && cmd !== 'SETAI' && cmd !== 'ENDCHAT') {
            const lang = getLang(sid);
            const session = aiConversations.get(sid);
            const question = body.trim();
            const reg = db.registrations[sid];
            const stuName = reg ? STUDENTS[reg]?.name?.split(' ')[0] : 'Student';
            const provKey = session?.providerKey || getAIProvider(sid);
            const prov = AI_PROVIDERS[provKey];
            const history = session?.history || [];
            history.push({ role: 'user', content: question });
            await reply(withFooter(`⏳ *${prov.emoji} ${prov.name} is thinking...*`));
            try {
                const sys = `You are a helpful academic assistant for SLIIT Year 1 Semester 1 students. Student: ${stuName}. Keep answers clear under 350 words. Use backticks for code. Reply in Sinhala if asked in Sinhala.`;
                const answer = await prov.call(question, sys, history.slice(-8), 900);
                history.push({ role: 'assistant', content: answer });
                aiConversations.set(sid, { history: history.slice(-10), lastActivity: Date.now(), providerKey: provKey });
                const turn = Math.floor(history.length/2);
                await reply(withFooter(`${prov.emoji} *${prov.name}* (Turn ${turn})

❓ *${question}*

💡 *Answer:*
${answer}

_💬 Reply to continue | *ENDCHAT* to end_`));
            } catch(e) {
                console.error('AI reply error:', e.message);
                await reply(withFooter(`❌ *${prov.name} unavailable.* Try *SETAI llama*`));
            }
            return;
        }

        // ── YES/NO: Group join confirmation ────────────────────────────────────
        if (cmd === 'YES' || cmd === 'NO' || cmd === 'Y' || cmd === 'N') {
            const pending = pendingGroupConfirm.get(sid);
            if (pending && pending.expiresAt > Date.now()) {
                pendingGroupConfirm.delete(sid);
                if (cmd === 'YES' || cmd === 'Y') {
                    await reply(withFooter(`⏳ *Adding you to your project group...*\nPlease wait a moment.`));
                    const groupMsg = await handleGroupJoin(sid, pending.studentData, pending.regKey);
                    await reply(withFooter(`✅ *Group Join Complete!*` + groupMsg + `\n\n💡 Send *MYGROUPS* to see your group details.`));
                } else {
                    await reply(withFooter([
                        `👍 *Skipped group join.*`,
                        ``,
                        `You can join anytime — send *MYGROUPS* to see your group link.`,
                    ].join('\n')));
                }
                return;
            }
            // No pending confirmation — fall through to unknown command
        }

        // ══════════════════════════════════════════════════════════════════════
        // USER COMMANDS
        // ══════════════════════════════════════════════════════════════════════

        // ── HELP / HI / HELLO / START ─────────────────────────────────────────
        if (cmd === 'HELP' || cmd === 'HI' || cmd === 'HELLO' || cmd === 'START' || cmd === 'MENU') {
            const reg  = db.registrations[sid];
            const name = reg ? STUDENTS[reg]?.name?.split(' ')[0] : null;
            const lang = getLang(sid);
            const greet = timeGreeting(lang);
            const quote = randomQuote(lang);
            const greeting = name ? (lang==='si' ? `👋 ආයුබෝවන් *${name}!*` : `👋 Hi, *${name}!*`) : (lang==='si' ? `👋 *SLIIT Y1S1 Bot එකට සාදරයෙන් පිළිගනිමු!*` : `👋 *Welcome to SLIIT Y1S1 Bot!*`);

            let lines;
            if (lang === 'si') {
                lines = [
                    `╔══════════════════════════════╗`,
                    `  🎓 *SLIIT Y1S1 Assistant Bot*`,
                    `╚══════════════════════════════╝`,
                    ``,
                    greet, greeting, ``,
                    `💬 _${quote}_`,
                    ``,
                    `━━━━ 📌 *Registration* ━━━━`,
                    ``,
                    `*REG IT26XXXXXX*`,
                    `  Register with your SLIIT IT number`,
                    ``,
                    `━━━━ 👤 *My Profile* ━━━━`,
                    ``,
                    `*MYINFO*          📋 Your student profile`,
                    `*MYGROUPS*        📊 Timetable & group info`,
                    `*MYLINK*          🔗 Your WhatsApp group link`,
                    `*MYEAC*           📚 Your EAC group info`,
                    `*CLASSMATES*      👥 See your groupmates`,
                    `*JOINGROUP WD01*  🏘️ Get any group link`,
                    ``,
                    `━━━━ 📅 *Timetable* ━━━━`,
                    ``,
                    `*TODAY*      📆 Today's schedule`,
                    `*TOMORROW*   📆 Tomorrow's classes`,
                    `*NEXT*       ⏰ Next class now`,
                    `*WEEK*       📋 Full weekly view`,
                    `*TT Friday*  📅 Day-specific timetable`,
                    ``,
                    `━━━━ 🔍 *Search* ━━━━`,
                    ``,
                    `*INFO IT26XXXXXX*  🔍 Any student's info`,
                    `*SEARCH <name>*    🔎 Search by name`,
                    ``,
                    `━━━━ 🤖 *AI Assistant* ━━━━`,
                    ``,
                    `*ASK <question>*  🧠 Ask AI anything!`,
                    `  💬 Reply to AI message to continue chat`,
                    `  e.g. ASK What is OOP?`,
                    `*SETAI llama*     🦙 Llama 3.3 70B (default)`,
                    `*SETAI gemini*    🟦 Google Gemma 2`,
                    `*SETAI mistral*   ⚡ Mistral Saba`,
                    `*SETAI deepseek*  🔬 DeepSeek R1`,
                    `*QUOTE*           💬 Motivational quote`,
                    `*ENDCHAT*         🔚 End AI session`,
                    ``,
                    `━━━━ 🎨 *Creative Tools* ━━━━`,
                    ``,
                    `*IMAGE <description>*  🖼️ Generate AI image`,
                    `  e.g. IMAGE futuristic SLIIT campus`,
                    `*SLIDES <topic>*       📊 AI presentation`,
                    `  e.g. SLIDES Intro to OOP`,
                    `*VIDEO <topic>*        🎬 Find tutorials`,
                    `  e.g. VIDEO database normalization`,
                    ``,
                    `━━━━ 🎯 *Quiz & Practice* ━━━━`,
                    ``,
                    `*QUIZ*            🎯 Random quiz question`,
                    `*QUIZ english*    📝 English grammar quiz`,
                    `*QUIZ ielts*      🎓 IELTS practice`,
                    `*QUIZ java*       ☕ Java quiz`,
                    `*QUIZ python*     🐍 Python quiz`,
                    `*QUIZ coding*     💻 Coding concepts`,
                    `  💬 Just reply with your answer!`,
                    ``,
                    `━━━━ 🌐 *Language* ━━━━`,
                    ``,
                    `*LANG SI*  🇱🇰 Sinhala`,
                    `*LANG EN*  🇬🇧 English (current)`,
                    ``,
                    `━━━━ ℹ️ *About* ━━━━`,
                    ``,
                    `📞 SLIIT Help: *+94 11 754 4801*`,
                    `⚠️ _Not associated with SLIIT operations_`,
                ];
            } else {
                lines = [
                    `╔════════════════════════════╗`,
                    `  🎓 *SLIIT Y1S1 Assistant Bot*`,
                    `╚════════════════════════════╝`,
                    ``,
                    greet, greeting, ``,
                    `💬 _${quote}_`,
                    ``,
                    `━━━━ 📌 *Registration* ━━━━`,``,
                    `*REG IT26XXXXXX*`,
                    `  Register with your SLIIT IT number`,
                    ``,
                    `━━━━ 👤 *My Profile* ━━━━`,``,
                    `*MYINFO*          📋 Your student profile`,
                    `*MYGROUPS*        📊 Timetable & group info`,
                    `*MYLINK*          🔗 Your WhatsApp group link`,
                    `*MYEAC*           📚 Your EAC group info`,
                    `*CLASSMATES*      👥 See your groupmates`,
                    `*JOINGROUP WD01*  🏘️ Get any group link`,
                    ``,
                    `━━━━ 📅 *Timetable* ━━━━`,``,
                    `*TODAY*      📆 Today's schedule`,
                    `*TOMORROW*   📆 Tomorrow's classes`,
                    `*NEXT*       ⏰ Next class now`,
                    `*WEEK*       📋 Full weekly view`,
                    `*TT Friday*  📅 Day-specific timetable`,
                    ``,
                    `━━━━ 🔍 *Search* ━━━━`,``,
                    `*INFO IT26XXXXXX*  🔍 Any student info`,
                    `*SEARCH <name>*    🔎 Search by name`,
                    ``,
                    `━━━━ 🤖 *AI Assistant* ━━━━`,``,
                    `  💬 Reply to continue the chat`,
                    `*SETAI llama*     🦙 Llama 3.3 70B`,
                    `*SETAI gemini*    🟦 Google Gemma 2`,
                    `*SETAI mistral*   ⚡ Mistral Saba`,
                    `*SETAI deepseek*  🔬 DeepSeek R1`,
                    `*QUOTE*           💬 Motivational quote`,
                    `*ENDCHAT*         🔚 End AI session`,
                    ``,
                    `━━━━ 🎨 *Creative Tools* ━━━━`,``,
                    `*IMAGE <description>*  🖼️ AI image`,
                    `*SLIDES <topic>*       📊 AI presentation`,
                    `*VIDEO <topic>*        🎬 Find tutorials`,
                    ``,
                    `━━━━ 🎯 *Quiz & Practice* ━━━━`,``,
                    `*QUIZ*            🎯 Random quiz question`,
                    `*QUIZ english*    📝 English grammar quiz`,
                    `*QUIZ ielts*      🎓 IELTS practice`,
                    `*QUIZ java*       ☕ Java quiz`,
                    `*QUIZ python*     🐍 Python quiz`,
                    `*QUIZ coding*     💻 Coding concepts`,
                    `  💬 Just reply with your answer!`,
                    ``,
                    `━━━━ 🌐 *Language* ━━━━`,``,
                    `*LANG SI*  🇱🇰 Sinhala`,
                    `*LANG EN*  🇬🇧 English (current)`,
                    ``,
                    `━━━━ ℹ️ *About* ━━━━`,``,
                    `📞 SLIIT Help: *+94 11 754 4801*`,
                    `⚠️ _Not associated with SLIIT operations_`,
                ];
            }
            if (isAdmin(sid)) lines.push(``, `🛡️ *Admin:* Send *ADMINHELP* for admin commands.`);
            await reply(withFooter(lines.join('\n')));
            return;
        }

        // ── IMAGE — AI image generation (Pollinations - free) ─────────────────
        if (cmd === 'IMAGE' || cmd === 'IMG' || cmd === 'IMAGINE') {
            const lang = getLang(sid);
            const prompt = body.replace(/^(IMAGE|IMG|IMAGINE)\s*/i, '').trim();
            if (!prompt) {
                await reply(withFooter(lang==='si'
                    ? '❌ *Description එකක් දෙන්න!*\n\nඋදා: *IMAGE a beautiful sunset*'
                    : '❌ *Include a description!*\n\nExample: *IMAGE a futuristic SLIIT campus*\nExample: *IMAGE a programmer at night*'
                ));
                return;
            }
            await reply(withFooter(lang==='si'
                ? `⏳ *AI Image හදනවා...*\n\n"${prompt.slice(0,50)}"\n\nරැඳී සිටින්න! (10-20s)`
                : `⏳ *Generating AI Image...*\n\n"${prompt.slice(0,50)}"\n\nPlease wait (10-20s)!`
            ));
            const fetchImage = async (seed) => {
                const encodedPrompt = encodeURIComponent(prompt + ', high quality, detailed, digital art');
                const imageUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=800&height=600&nologo=true&model=flux&seed=${seed}`;
                const resp = await fetch(imageUrl, {
                    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SLIITBot/1.0)' },
                    signal: AbortSignal.timeout(45000)
                });
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const contentType = resp.headers.get('content-type') || '';
                const buffer = Buffer.from(await resp.arrayBuffer());
                if (!contentType.startsWith('image/') || buffer.length < 2000) {
                    throw new Error(`Bad response (type=${contentType}, size=${buffer.length})`);
                }
                return buffer;
            };
            try {
                let buffer;
                try {
                    buffer = await fetchImage(Date.now());
                } catch (e1) {
                    console.warn('Image attempt 1 failed:', e1.message, '— retrying...');
                    await sleep(1500);
                    buffer = await fetchImage(Date.now() + 1);
                }
                await directSend(sid, {
                    image: buffer,
                    caption: withFooter(lang==='si'
                        ? `🎨 *AI Generated Image*\n\n📝 "${prompt}"\n\n_නව image: IMAGE <description>_`
                        : `🎨 *AI Generated Image*\n\n📝 "${prompt}"\n\n_More: IMAGE <description>_`
                    )
                });
            } catch(e) {
                console.error('Image error:', e.message);
                await reply(withFooter(lang==='si'
                    ? '❌ *Image generate කිරීමට අසමත් විය.*\n\nසේවාව තාවකාලිකව busy විය හැක. ස්වල්ප වෙලාවකින් නැවත try කරන්න, හෝ description එක සරල කරන්න.'
                    : '❌ *Could not generate the image right now.*\n\nThe image service may be busy. Try again in a moment, or use a simpler description.'
                ));
            }
            return;
        }

        // ── VIDEO — YouTube educational search ────────────────────────────────
        if (cmd === 'VIDEO' || cmd === 'YOUTUBE' || cmd === 'YT') {
            const lang = getLang(sid);
            const query = body.replace(/^(VIDEO|YOUTUBE|YT)\s*/i, '').trim();
            if (!query) {
                await reply(withFooter('❌ Include a topic!\n\nExample: *VIDEO OOP in Java*\nExample: *VIDEO Database normalization*'));
                return;
            }
            const ytSearch = encodeURIComponent(query + ' tutorial');
            await reply(withFooter([
                `🎬 *Educational Videos*`,
                ``,
                `📚 Topic: *${query}*`,
                ``,
                `🔗 Watch on YouTube:`,
                `https://www.youtube.com/results?search_query=${ytSearch}`,
                ``,
                `💡 Also try:`,
                `• ${query} for beginners`,
                `• ${query} explained simply`,
                `• ${query} crash course`,
            ].join('\n')));
            return;
        }

        // ── SLIDES — AI presentation maker ────────────────────────────────────
        if (cmd === 'SLIDES' || cmd === 'PPT' || cmd === 'PRESENTATION') {
            const lang = getLang(sid);
            const topic = body.replace(/^(SLIDES|PPT|PRESENTATION)\s*/i, '').trim();
            if (!topic) {
                await reply(withFooter(lang==='si'
                    ? '❌ Topic එකක් දෙන්න!\n\nඋදා: *SLIDES Introduction to OOP*'
                    : '❌ Include a topic!\n\nExample: *SLIDES Introduction to OOP*\nExample: *SLIDES Cloud Computing*'
                ));
                return;
            }
            const provKey = getAIProvider(sid);
            const prov = AI_PROVIDERS[provKey];
            await reply(withFooter(`⏳ *${prov.emoji} Creating presentation...*\n\nTopic: "${topic.slice(0,50)}"`));
            try {
                const reg = db.registrations[sid];
                const stuName = reg ? STUDENTS[reg]?.name?.split(' ')[0] : 'Student';
                const sys = 'You are an expert presentation creator for university students.';
                const prompt = `Create a detailed slide-by-slide presentation for SLIIT Year 1 student "${stuName}" on: "${topic}"

Use this EXACT format for each slide:

📑 SLIDE 1 — TITLE
- Main Title: [title]
- Subtitle: [subtitle]
- Hook: [one interesting fact]

📑 SLIDE 2 — AGENDA
- Point 1
- Point 2
- Point 3
- Point 4

📑 SLIDE 3 — [topic]
- Key point 1
- Key point 2
- Key point 3
🗣️ Speaker note: [what to say]

[Continue for 5-7 more slides]

📑 FINAL SLIDE — THANK YOU
- Summary: [3 key takeaways]
- Contact: [student name]
- Q&A

Keep bullets under 8 words each. Make it professional.`;
                const answer = await prov.call(prompt, sys, [], 1800);
                if (answer.length > 3800) {
                    const mid = answer.lastIndexOf('📑', Math.floor(answer.length/2));
                    const splitAt = mid > 100 ? mid : Math.floor(answer.length/2);
                    await reply(withFooter(`📊 *AI Presentation (Part 1)*\n\n${answer.slice(0, splitAt)}`));
                    await sleep(1200);
                    await reply(withFooter(`📊 *AI Presentation (Part 2)*\n\n${answer.slice(splitAt)}\n\n_💡 Copy to Google Slides or PowerPoint!_`));
                } else {
                    await reply(withFooter(`📊 *AI Presentation*\n\n${answer}\n\n_💡 Copy to Google Slides or PowerPoint!_`));
                }
            } catch(e) {
                console.error('Slides error:', e.message);
                await reply(withFooter('❌ Could not create presentation. Try again.'));
            }
            return;
        }

        // ── LANG — language selection ─────────────────────────────────────────
        if (cmd === 'LANG') {
            if (!db.languages) db.languages = {};
            const ch = (arg1||'').toUpperCase();
            if (ch==='SI'||ch==='SINHALA') {
                db.languages[sid]='si'; saveDB();
                await reply(withFooter('✅ *භාෂාව සිංහලට සකසන ලදී!*\n\nHelp menu සඳහා *HELP* යවන්න.'));
                return;
            }
            if (ch==='EN'||ch==='ENGLISH') {
                db.languages[sid]='en'; saveDB();
                await reply(withFooter('✅ *Language set to English!*\n\nSend *HELP* to see the menu.'));
                return;
            }
            await reply(withFooter('🌐 *Choose language / භාෂාව තෝරන්න*\n\n*LANG EN* — English\n*LANG SI* — සිංහල'));
            return;
        }

        // ── SETAI ────────────────────────────────────────────────────────────
        if (cmd === 'SETAI' || cmd === 'USEAI') {
            const lang = getLang(sid);
            const ch = (arg1||'').toLowerCase();
            if (!ch) {
                const cur = getAIProvider(sid);
                const lines = [
                    lang==='si' ? '🤖 *AI සේවාව තෝරන්න*' : '🤖 *Select AI Provider*', '',
                    (lang==='si' ? 'දැනට: ' : 'Current: ') + AI_PROVIDERS[cur].emoji + ' *' + AI_PROVIDERS[cur].name + '*', '',
                    '*SETAI gemini*  🟦 Google Gemma 4 ✅',
                    '*SETAI llama*   🦙 Llama Nvidia ✅',
                    '*SETAI kimi*    🌙 Kimi AI ✅',
                    '*SETAI liquid*  💧 Liquid AI ✅',
                ];
                await reply(withFooter(lines.join('\n'))); return;
            }
            if (!AI_PROVIDERS[ch]) {
                await reply(withFooter('❌ Options: *SETAI gemini* or *SETAI llama*')); return;
            }
            if (!db.aiProvider) db.aiProvider = {};
            db.aiProvider[sid] = ch; saveDB();
            await reply(withFooter('✅ *AI set to ' + AI_PROVIDERS[ch].emoji + ' ' + AI_PROVIDERS[ch].name + '!*\n\nNow use *ASK <question>*'));
            return;
        }

        // ── QUOTE — motivational quote ────────────────────────────────────────
        if (cmd === 'QUOTE' || cmd === 'MOTIVATE') {
            const lang = getLang(sid);
            const q = randomQuote(lang);
            await reply(withFooter(`💬 *${lang==='si'?'දිරිගැන්වීම':'Motivation'}*\n\n_${q}_`));
            return;
        }

        // ── MYEAC — Show EAC (English for Academic Communication) group info ────
        if (cmd === 'MYEAC' || cmd === 'EAC') {
            const lang = getLang(sid);
            const reg = db.registrations[sid];
            if (!reg) { await reply(withFooter(lang==='si'?'⚠️ ලියාපදිංචි වී නැත. *REG IT26XXXXXX* යවන්න.':'⚠️ Not registered. Send *REG IT26XXXXXX* first.')); return; }
            const eacGroup = EAC_GROUPS[reg];
            if (!eacGroup) { await reply(withFooter(`⚠️ No EAC group found for *${reg}*. Contact admin.`)); return; }
            const ttNum  = eacGroup.slice(0,2);
            const subGrp = eacGroup.slice(2);
            await reply(withFooter([
                `╔══════════════════════════╗`,
                `  📚 *EAC Group Info*`,
                `╚══════════════════════════╝`,
                ``,
                `🆔 Student:     *${reg}*`,
                ``,
                `📋 *EAC Group:*  ${eacGroup}`,
                `📌 *Class Name:* Y1.S1.WD.IT.${ttNum}.${subGrp}`,
                `📚 *Subject:*    English for Academic Communication`,
                ``,
                `💡 Your EAC class is in Group *${eacGroup}*`,
            ].join('\n')));
            return;
        }

        // ── QUIZ — Daily practice questions (AI generated) ───────────────────────
        if (cmd === 'QUIZ' || cmd === 'PRACTICE' || cmd === 'Q') {
            const lang = getLang(sid);
            const category = (arg1||'').toLowerCase();
            const categories = ['english','grammar','ielts','speaking','java','python','html','coding','pseudo','all'];
            if (category && !categories.includes(category)) {
                await reply(withFooter([
                    `╔══════════════════════════╗`,
                    `  🎯 *Quiz Categories*`,
                    `╚══════════════════════════╝`,
                    ``,
                    `*QUIZ english*   📝 English grammar`,
                    `*QUIZ ielts*     🎓 IELTS preparation`,
                    `*QUIZ speaking*  🗣️ Speaking skills`,
                    `*QUIZ java*      ☕ Java programming`,
                    `*QUIZ python*    🐍 Python programming`,
                    `*QUIZ html*      🌐 HTML/CSS/Web`,
                    `*QUIZ coding*    💻 General coding`,
                    `*QUIZ pseudo*    📋 Pseudocode/Logic`,
                    `*QUIZ all*       🎲 Random category`,
                    ``,
                    `_Just send *QUIZ* for a random question!_`,
                ].join('\n')));
                return;
            }
            const prov = AI_PROVIDERS[getAIProvider(sid)];
            await reply(withFooter(`⏳ *${prov.emoji} Generating quiz question...*`));
            try {
                const cat = category || 'all';
                const catMap = {
                    english: 'English grammar (fill in the blank, correct the sentence, or choose the right word)',
                    grammar: 'English grammar rules and usage',
                    ielts: 'IELTS exam preparation (vocabulary, reading comprehension, or writing task)',
                    speaking: 'English speaking and communication skills',
                    java: 'Java programming (syntax, OOP, data structures)',
                    python: 'Python programming (syntax, functions, data structures)',
                    html: 'HTML, CSS, or basic web development',
                    coding: 'Programming concepts (algorithms, debugging, logic)',
                    pseudo: 'Pseudocode writing or algorithm logic',
                    all: 'any of: English grammar, IELTS, Java, Python, HTML, or programming concepts',
                };
                const catDesc = catMap[cat] || catMap.all;
                const prompt = `Create ONE quiz question about: ${catDesc}
For SLIIT Year 1 university students.

Reply in EXACTLY this format (no extra text):
QUESTION: [the question - make it clear and specific]
ANSWER: [the correct answer - be concise]
CATEGORY: [${cat === 'all' ? 'detected category' : cat}]
DIFFICULTY: [easy/medium/hard]`;
                const result = await prov.call(prompt, 'You are a university quiz creator. Create clear, educational questions.', [], 350);
                const qMatch    = result.match(/QUESTION:\s*(.+)/i);
                const aMatch    = result.match(/ANSWER:\s*(.+)/i);
                const catMatch  = result.match(/CATEGORY:\s*(.+)/i);
                const diffMatch = result.match(/DIFFICULTY:\s*(.+)/i);
                if (!qMatch || !aMatch) throw new Error('Bad format');
                const question = qMatch[1].trim();
                const answer = aMatch[1].trim();
                const detectedCat = (catMatch?.[1]?.trim() || cat).replace(/[\[\]]/g, '');
                const difficulty  = (diffMatch?.[1]?.trim() || 'medium').replace(/[\[\]]/g, '');
                quizSessions.set(sid, { question, answer, category: detectedCat, asked: Date.now() });
                const diffEmoji = difficulty.toLowerCase().includes('easy') ? '🟢' : difficulty.toLowerCase().includes('hard') ? '🔴' : '🟡';
                await reply(withFooter([
                    `🎯 *Quiz Time!*`,
                    ``,
                    `📚 Category: *${detectedCat.toUpperCase()}*  ${diffEmoji} ${difficulty}`,
                    ``,
                    `❓ *${question}*`,
                    ``,
                    `_Reply with your answer!_`,
                    `_Send *QUIZ* to skip & get a new question_`,
                ].join('\n')));
            } catch(e) {
                console.error('Quiz error:', e.message);
                await reply(withFooter('❌ Could not generate a question. Try *QUIZ english* or *QUIZ java*.'));
            }
            return;
        }

        // ── ASK — AI with conversation memory ───────────────────────────────────
        if (cmd === 'ASK' || cmd === 'AI') {
            const lang = getLang(sid);
            const question = body.replace(/^(ASK|AI)\s*/i, '').trim();
            if (!question) {
                await reply(withFooter(lang==='si'
                    ? '❌ ප්‍රශ්නයක් යවන්න!\n\nඋදා: *ASK What is OOP?*'
                    : '❌ Include your question!\n\nExample: *ASK What is OOP?*\nSwitch AI: *SETAI llama*'
                ));
                return;
            }
            const reg = db.registrations[sid];
            const stuName = reg ? STUDENTS[reg]?.name?.split(' ')[0] : 'Student';
            const provKey = getAIProvider(sid);
            const prov = AI_PROVIDERS[provKey];
            const session = aiConversations.get(sid) || { history: [], lastActivity: Date.now(), providerKey: provKey };
            session.history.push({ role: 'user', content: question });
            session.lastActivity = Date.now();
            session.providerKey = provKey;
            await reply(withFooter(lang==='si'
                ? `⏳ *${prov.emoji} ${prov.name} සිතනවා...*`
                : `⏳ *${prov.emoji} ${prov.name} is thinking...*`
            ));
            try {
                const sys = `You are a helpful academic assistant for SLIIT Year 1 Semester 1 students. Student: ${stuName}. Answer questions about programming, databases, maths, IT concepts. Keep answers clear under 350 words. Format code with backticks. Reply in Sinhala if asked in Sinhala.`;
                const answer = await prov.call(question, sys, session.history.slice(-8), 900);
                session.history.push({ role: 'assistant', content: answer });
                aiConversations.set(sid, { ...session, history: session.history.slice(-10) });
                const turn = Math.floor(session.history.length/2);
                const header = lang==='si'
                    ? `${prov.emoji} *${prov.name} සහායක* (Turn ${turn})\n\n❓ *${question}*\n\n💡 *පිළිතුර:*\n`
                    : `${prov.emoji} *${prov.name} Assistant* (Turn ${turn})\n\n❓ *${question}*\n\n💡 *Answer:*\n`;
                const foot = lang==='si'
                    ? `\n\n_💬 Reply to continue | *ENDCHAT* end_`
                    : `\n\n_💬 *Reply* to continue the chat | *ENDCHAT* to end_`;
                await reply(withFooter(header + answer + foot));
            } catch(e) {
                console.error('AI error:', e.message);
                await reply(withFooter(lang==='si'
                    ? `❌ *${prov.name} ලබා ගත නොහැක.* *SETAI llama* try.`
                    : `❌ *${prov.name} unavailable.* Try: *SETAI llama*`
                ));
            }
            return;
        }

        // ── MYLINK ────────────────────────────────────────────────────────────
        if (cmd === 'MYLINK') {
            const reg = db.registrations[sid];
            if (!reg) {
                await reply(withFooter(`⚠️ *Not Registered*\n\nSend *REG IT26XXXXXX* to register first.`));
                return;
            }
            const pg   = STUDENTS[reg]?.project_group;
            const slot = db.students[reg]?.wa_group_slot || pg;
            const wg   = db.waGroups[slot];
            if (!wg) {
                await reply(withFooter(`⚠️ Group *${slot}* hasn't been created yet.\nSend *REG ${reg}* to trigger group creation.`));
                return;
            }
            if (!wg.inviteLink) {
                try {
                    const code = await sock.groupInviteCode(wg.jid);
                    wg.inviteLink = `https://chat.whatsapp.com/${code}`;
                    saveDB();
                } catch(e) {
                    await reply(withFooter(`❌ Could not fetch group link: ${e.message}`));
                    return;
                }
            }
            await reply(withFooter([
                `🔗 *Your Project Group Link*`,
                ``,
                `📌 Group: *${slot}*`,
                ``,
                `${wg.inviteLink}`,
                ``,
                `Tap the link to join your group.`,
            ].join('\n')));
            return;
        }

        // ── TODAY ─────────────────────────────────────────────────────────────
        if (cmd === 'TODAY') {
            const reg = db.registrations[sid];
            if (!reg) {
                await reply(withFooter(`⚠️ *Not Registered*\n\nSend *REG IT26XXXXXX* first.`));
                return;
            }
            const today = getSLDay(new Date());
            if (today === 'Saturday' || today === 'Sunday') {
                await reply(withFooter([
                    `🎉 *It's the Weekend!*`,
                    ``,
                    `No weekday classes today (${today}).`,
                    `Use *TIMETABLE Monday* to check upcoming classes.`,
                ].join('\n')));
                return;
            }
            await reply(buildTimetableMessage(reg, today));
            return;
        }

        // ── TOMORROW ──────────────────────────────────────────────────────────
        if (cmd === 'TOMORROW') {
            const reg = db.registrations[sid];
            if (!reg) {
                await reply(withFooter(`⚠️ *Not Registered*\n\nSend *REG IT26XXXXXX* first.`));
                return;
            }
            const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
            const slOffset = 5.5 * 60 * 60 * 1000;
            const slNow    = new Date(Date.now() + slOffset);
            const tomorrowIdx = (slNow.getUTCDay() + 1) % 7;
            const tomorrow = days[tomorrowIdx];
            if (tomorrow === 'Saturday' || tomorrow === 'Sunday') {
                await reply(withFooter([
                    `📅 *Tomorrow is ${tomorrow}*`,
                    ``,
                    `No weekday classes on weekends.`,
                    `Use *TIMETABLE Monday* for the next weekday.`,
                ].join('\n')));
                return;
            }
            await reply(buildTimetableMessage(reg, tomorrow));
            return;
        }

        // ── TIMETABLE / TT ────────────────────────────────────────────────────
        if (cmd === 'TIMETABLE' || cmd === 'TT') {
            const reg = db.registrations[sid];
            if (!reg) {
                await reply(withFooter(`⚠️ *Not Registered*\n\nSend *REG IT26XXXXXX* first.`));
                return;
            }
            const validDays = ['Monday','Tuesday','Wednesday','Thursday','Friday'];
            if (!arg1) {
                await reply(withFooter([
                    `📅 *Timetable Commands*`,
                    ``,
                    `*TODAY*       → Today's classes`,
                    `*TOMORROW*    → Tomorrow's classes`,
                    `*TIMETABLE <day>*`,
                    ``,
                    `Available days:`,
                    validDays.map(d => `  • ${d}`).join('\n'),
                    ``,
                    `Example: TIMETABLE Wednesday`,
                ].join('\n')));
                return;
            }
            const dayInput = arg1.charAt(0).toUpperCase() + arg1.slice(1).toLowerCase();
            if (!validDays.includes(dayInput)) {
                await reply(withFooter([
                    `❌ *Invalid Day: "${arg1}"*`,
                    ``,
                    `Valid days:`,
                    validDays.map(d => `  • ${d}`).join('\n'),
                    ``,
                    `Example: TIMETABLE Friday`,
                ].join('\n')));
                return;
            }
            await reply(buildTimetableMessage(reg, dayInput));
            return;
        }

        // ── WEEK ──────────────────────────────────────────────────────────────
        if (cmd === 'WEEK') {
            const reg = db.registrations[sid];
            if (!reg) { await reply(withFooter(`⚠️ *Not Registered*\n\nSend *REG IT26XXXXXX* first.`)); return; }
            const studentData = STUDENTS[reg];
            if (!studentData) { await reply(withFooter('❌ Student data error.')); return; }
            const timetableGroup = studentData.timetable_group;
            const isWE = timetableGroup.includes('WE');
            if (isWE) {
                await reply(withFooter(`ℹ️ You are in the *Weekend* batch. This timetable covers weekday groups only.`));
                return;
            }
            if (!TIMETABLE[timetableGroup]) {
                await reply(withFooter(`❌ No timetable data found for group *${timetableGroup}*`));
                return;
            }
            const weekDays = ['Monday','Tuesday','Wednesday','Thursday','Friday'];
            const today = getSLDay(new Date());
            const lines = [
                `╔══════════════════════════╗`,
                `  📅 *WEEKLY OVERVIEW*`,
                `╚══════════════════════════╝`,
                ``,
                `👤 ${studentData.name}`,
                `📚 ${timetableGroup}`,
                ``,
            ];
            for (const day of weekDays) {
                const isToday = day === today;
                const result = getStudentTodayTimetable(reg, day);
                const groupTT = TIMETABLE[timetableGroup];
                const dayTT = groupTT?.[day] || {};
                const subjects = Object.values(dayTT)
                    .flat()
                    .map(s => s.subject?.replace(/ (Lecture|Tutorial|Practical|Lab)$/i, ''))
                    .filter((v, i, a) => a.indexOf(v) === i)
                    .slice(0, 3);
                const count = Object.values(dayTT).flat().length;
                const marker = isToday ? ' ◀ TODAY' : '';
                if (count === 0) {
                    lines.push(`*${day}${marker}:* 🎉 No classes`);
                } else {
                    lines.push(`*${day}${marker}:* ${count} class${count > 1 ? 'es' : ''}`);
                    subjects.forEach(s => lines.push(`   • ${s}`));
                }
            }
            lines.push(``, `📌 Send *TIMETABLE <day>* for full details.`);
            lines.push(`⏭ Send *NEXT* to see your next class now.`);
            await reply(withFooter(lines.join('\n')));
            return;
        }

        // ── NEXTCLASS ─────────────────────────────────────────────────────────
        // Shows the very next upcoming class for the student today
        if (cmd === 'NEXT' || cmd === 'NEXTCLASS') {
            const reg = db.registrations[sid];
            if (!reg) { await reply(withFooter(`⚠️ *Not Registered*\n\nSend *REG IT26XXXXXX* first.`)); return; }
            const studentData = STUDENTS[reg];
            if (!studentData) { await reply(withFooter('❌ Student data error.')); return; }
            const today = getSLDay(new Date());
            if (today === 'Saturday' || today === 'Sunday') {
                await reply(withFooter(`🎉 *It's the Weekend!*\n\nNo classes today. Enjoy! 🏖️\nSend *TIMETABLE Monday* for Monday's schedule.`));
                return;
            }
            const result = getStudentTodayTimetable(reg, today);
            const slOffset = 5.5 * 60 * 60 * 1000;
            const slNow = new Date(Date.now() + slOffset);
            const nowMins = slNow.getUTCHours() * 60 + slNow.getUTCMinutes();

            if (!result || !result.lines || result.lines.length === 0) {
                await reply(withFooter(`🎉 *No classes today (${today})!*\nEnjoy your free day! 🏖️`));
                return;
            }

            // Parse session times from timetable for today
            const groupTT = TIMETABLE[studentData.timetable_group];
            const dayTT   = groupTT?.[today] || {};
            const ttSubResult = getStudentTodayTimetable(reg, today);

            // Build sorted list of (timeInMins, session) for today
            const sessions = [];
            for (const [timeStr, sessList] of Object.entries(dayTT)) {
                const [h, m] = timeStr.split(':').map(Number);
                const totalMins = h * 60 + m;
                for (const s of sessList) {
                    sessions.push({ totalMins, timeStr, ...s });
                }
            }
            sessions.sort((a, b) => a.totalMins - b.totalMins);

            const upcoming = sessions.filter(s => s.totalMins > nowMins);
            const ongoing  = sessions.find(s => s.totalMins <= nowMins && s.totalMins + 60 > nowMins);

            if (ongoing) {
                const minsLeft = (ongoing.totalMins + 60) - nowMins;
                await reply(withFooter([
                    `╔═══════════════════════╗`,
                    `  🔴 *CLASS IN PROGRESS*`,
                    `╚═══════════════════════╝`,
                    ``,
                    `⏰ Started: *${ongoing.timeStr}*`,
                    `⏱  Ends in: ~${minsLeft} min`,
                    `📖 *${ongoing.subject}*`,
                    ongoing.teacher ? `👩‍🏫 ${ongoing.teacher}` : '',
                    ongoing.room    ? `🏫 Room: ${ongoing.room}` : '',
                    upcoming.length > 0
                        ? `\n⏭ *Next after this:* ${upcoming[0].timeStr} — ${upcoming[0].subject}`
                        : `\n✅ This is your last class today.`,
                ].filter(l => l !== '').join('\n')));
            } else if (upcoming.length > 0) {
                const next = upcoming[0];
                const minsUntil = next.totalMins - nowMins;
                const hrs = Math.floor(minsUntil / 60);
                const mins = minsUntil % 60;
                const etaStr = hrs > 0 ? `${hrs}h ${mins}m` : `${mins} min`;
                await reply(withFooter([
                    `╔═══════════════════════╗`,
                    `  ⏭ *NEXT CLASS*`,
                    `╚═══════════════════════╝`,
                    ``,
                    `⏰ *${next.timeStr}* — in *${etaStr}*`,
                    `📖 *${next.subject}*`,
                    next.teacher ? `👩‍🏫 ${next.teacher}` : '',
                    next.room    ? `🏫 Room: ${next.room}` : '',
                    ``,
                    upcoming.length > 1
                        ? `📋 ${upcoming.length - 1} more class${upcoming.length > 2 ? 'es' : ''} after this today.`
                        : `✅ This will be your last class today.`,
                ].filter(l => l !== '').join('\n')));
            } else {
                await reply(withFooter(`✅ *All classes done for today (${today})!*\n\nGreat job! See you tomorrow. 🌙`));
            }
            return;
        }

        // ── CLASSMATES ────────────────────────────────────────────────────────
        if (cmd === 'CLASSMATES' || cmd === 'GROUPMATES') {
            const reg = db.registrations[sid];
            if (!reg) { await reply(withFooter(`⚠️ *Not Registered*\n\nSend *REG IT26XXXXXX* first.`)); return; }
            const myData = STUDENTS[reg];
            if (!myData) { await reply(withFooter('❌ Student data error.')); return; }
            const myPG = myData.project_group;
            const mates = Object.entries(db.registrations)
                .filter(([, itNum]) => itNum !== reg && STUDENTS[itNum]?.project_group === myPG)
                .map(([, itNum]) => ({ itNum, name: STUDENTS[itNum]?.name || itNum }));
            const totalInGroup = Object.values(STUDENTS).filter(s => s.project_group === myPG).length;
            if (mates.length === 0) {
                await reply(withFooter([
                    `╔══════════════════════════╗`,
                    `  👥 *Project Classmates*`,
                    `╚══════════════════════════╝`,
                    ``,
                    `📌 Group: *${myPG}*`,
                    ``,
                    `😕 No one else from your project group has registered yet.`,
                    `Total students in this group: ${totalInGroup}`,
                ].join('\n')));
                return;
            }
            const lines = [
                `╔══════════════════════════╗`,
                `  👥 *Project Classmates*`,
                `╚══════════════════════════╝`,
                ``,
                `📌 Group: *${myPG}*`,
                `✅ Registered: ${mates.length + 1} / ${totalInGroup}`,
                ``,
            ];
            mates.forEach((m, i) => lines.push(`${i + 1}. *${m.name}*  (${m.itNum})`));
            lines.push(``, `💡 Only showing registered members.`);
            await reply(withFooter(lines.join('\n')));
            return;
        }

        // ── SEARCH / FIND ─────────────────────────────────────────────────────
        if (cmd === 'SEARCH' || cmd === 'FIND') {
            if (!arg1) {
                await reply(withFooter([
                    `🔍 *Search Students*`,
                    ``,
                    `Usage: *SEARCH <name or IT number>*`,
                    `Examples:`,
                    `  SEARCH Kavinda`,
                    `  SEARCH IT26101700`,
                ].join('\n')));
                return;
            }
            const query = rest.toLowerCase();
            const results = Object.entries(STUDENTS)
                .filter(([key, s]) => key.toLowerCase().includes(query) || s.name.toLowerCase().includes(query))
                .slice(0, 8);
            if (results.length === 0) {
                await reply(withFooter(`❌ *No students found for:* "${rest}"`));
                return;
            }
            const lines = [
                `🔍 *Search: "${rest}"*`,
                `Found ${results.length} match${results.length > 1 ? 'es' : ''}:`,
                ``,
            ];
            results.forEach(([key, s]) => {
                lines.push(`*${key}* — ${s.name}`);
                lines.push(`  📚 ${s.timetable_group}  |  🔢 ${s.project_group}`);
                lines.push('');
            });
            await reply(withFooter(lines.join('\n')));
            return;
        }

        if (cmd === 'ADMINHELP') {
            if (!isAdmin(sid)) { await reply(withFooter('❌ *Not Authorized*\nAdmin access required.')); return; }
            const lines = [
                `╔═══════════════════════════╗`,
                `  🛡️ *Admin Commands*`,
                `╚═══════════════════════════╝`,
                ``,
                `━━━━ 👥 *Member Management* ━━━━`,
                ``,
                `*ADDMEMBER IT26XXXXXX 94XXXXXXXXX*`,
                `  → Add student by REG + WA number`,
                ``,
                `*ADDTOGROUP IT26XXXXXX*`,
                `  → Re-add registered student to their group`,
                ``,
                `*FORCEREG IT26XXXXXX 94XXXXXXXXX*`,
                `  → Force-assign reg to WA number (overrides conflicts)`,
                ``,
                `*RMEMBER IT26XXXXXX*`,
                `  → Remove a student's registration`,
                ``,
                `━━━━ 🚫 *Moderation* ━━━━`,
                ``,
                `*BAN 94XXXXXXXXX*   → Ban a user`,
                `*UNBAN 94XXXXXXXXX* → Unban a user`,
                ``,
                `━━━━ 📡 *Communication* ━━━━`,
                ``,
                `*BROADCAST <message>*`,
                `  → Send message to ALL registered users`,
                ``,
                `━━━━ 📊 *Info & Status* ━━━━`,
                ``,
                `*STATS*              → Bot statistics`,
                `*LISTADMINS*         → List all admins`,
                `*LISTBANNED*         → List banned users`,
                `*GROUPSTATUS*        → All WA group slots & member counts`,
                `*GROUPLINK WD01*     → Get invite link for a group slot`,
                `*LOOKUP 94XXXXXXXXX* → Find student by WA number`,
                ``,
            ];
            if (isSuperAdmin(sid)) {
                lines.push(
                    `━━━━ ⚡ *Super Admin Only* ━━━━`,
                    ``,
                    `*ADDADMIN 94XXXXXXXXX*    → Promote to admin`,
                    `*REMOVEADMIN 94XXXXXXXXX* → Demote an admin`,
                    `*CREATEALLGROUPS*         → Create all project groups at once`,
                    ``,
                );
            }
            await reply(withFooter(lines.join('\n')));
            return;
        }

        // ── ADDMEMBER ─────────────────────────────────────────────────────────
        if (cmd === 'ADDMEMBER') {
            if (!isAdmin(sid)) { await reply(withFooter('❌ *Not Authorized*')); return; }
            if (!arg1 || !arg2) {
                await reply(withFooter([
                    `❌ *Missing Arguments*`,
                    ``,
                    `Usage: *ADDMEMBER IT26XXXXXX 94XXXXXXXXX*`,
                    ``,
                    `Example: ADDMEMBER IT26101700 94771234567`,
                ].join('\n')));
                return;
            }
            await adminAddMember(sid, arg1, arg2, reply);
            return;
        }

        // ── FORCEREG ──────────────────────────────────────────────────────────
        if (cmd === 'FORCEREG') {
            if (!isSuperAdmin(sid)) { await reply(withFooter('❌ *Super admin only.*')); return; }
            if (!arg1 || !arg2) {
                await reply(withFooter(`❌ Usage: *FORCEREG IT26XXXXXX 94XXXXXXXXX*`));
                return;
            }
            await forceReg(sid, arg1, arg2, reply);
            return;
        }

        // ── RMEMBER ───────────────────────────────────────────────────────────
        if (cmd === 'RMEMBER') {
            if (!isAdmin(sid)) { await reply(withFooter('❌ *Not Authorized*')); return; }
            if (!arg1) { await reply(withFooter(`❌ Usage: *RMEMBER IT26XXXXXX*`)); return; }
            const { key } = lookupStudent(arg1);
            const studentReg = db.students[key];
            if (!studentReg) { await reply(withFooter(`⚠️ *${key}* is not registered.`)); return; }
            const waNum = jidNum(studentReg.whatsapp || '');
            for (const [w, it] of Object.entries(db.registrations)) {
                if (it === key) delete db.registrations[w];
            }
            delete db.students[key];
            saveDB();
            await reply(withFooter([
                `✅ *Registration Removed*`,
                ``,
                `🆔 *Reg:* ${key}`,
                `📱 *WA:*  ${waNum || 'N/A'}`,
                ``,
                `Student has been unregistered from the bot.`,
                `Note: They are NOT removed from their WhatsApp group automatically.`,
            ].join('\n')));
            return;
        }

        // ── LOOKUP ────────────────────────────────────────────────────────────
        if (cmd === 'LOOKUP') {
            if (!isAdmin(sid)) { await reply(withFooter('❌ *Not Authorized*')); return; }
            if (!arg1) { await reply(withFooter(`❌ Usage: *LOOKUP 94XXXXXXXXX*`)); return; }
            const waNum = arg1.replace(/[^0-9]/g, '');
            // Search all registrations including LIDs
            let reg = null;
            for (const [j, id] of Object.entries(db.registrations)) {
                if (jidNum(j) === waNum) { reg = id; break; }
            }
            if (!reg) {
                await reply(withFooter(`❌ No registration found for number *${waNum}*`));
                return;
            }
            const data = STUDENTS[reg];
            if (!data) { await reply(withFooter(`⚠️ Reg *${reg}* found but no student data.`)); return; }
            let txt = fmtStudent(reg, data);
            txt += `\n📱 *WhatsApp:* ${waNum}`;
            const slot = db.students[reg]?.wa_group_slot || data.project_group;
            txt += `\n🏘️  *WA Slot:* ${slot}`;
            txt += `\n🕒 *Registered:* ${db.students[reg]?.registeredAt?.slice(0,10) || 'N/A'}`;
            await reply(withFooter(txt));
            return;
        }

        // ── STATS ─────────────────────────────────────────────────────────────
        if (cmd === 'STATS') {
            const slotCount = Object.keys(db.waGroups).length;
            const allPGs    = [...new Set(Object.values(STUDENTS).map(s => s.project_group))].length;
            const regCount  = Object.keys(db.registrations).length;
            const uptimeSecs = Math.floor(process.uptime());
            const uptimeStr = uptimeSecs < 60
                ? `${uptimeSecs}s`
                : uptimeSecs < 3600
                    ? `${Math.floor(uptimeSecs/60)}m ${uptimeSecs%60}s`
                    : `${Math.floor(uptimeSecs/3600)}h ${Math.floor((uptimeSecs%3600)/60)}m`;
            const slNow = new Date(Date.now() + 5.5 * 3600000);
            const slTime = slNow.toUTCString().replace('GMT', 'IST').replace(/:\d\d GMT/, ' IST');

            if (!isAdmin(sid)) {
                // Public stats — non-sensitive info only
                await reply(withFooter([
                    `╔══════════════════════════╗`,
                    `  📊 *Bot Status*`,
                    `╚══════════════════════════╝`,
                    ``,
                    `🟢 *Status:*       Online`,
                    `⏱  *Uptime:*       ${uptimeStr}`,
                    `🕐 *SL Time:*      ${slNow.toUTCString().slice(17,22)} IST`,
                    ``,
                    `👥 *Registered:*   ${regCount} students`,
                    `📦 *Total in DB:*  ${Object.keys(STUDENTS).length} students`,
                    `🔢 *Proj Groups:*  ${allPGs}`,
                ].join('\n')));
                return;
            }

            // Admin — full stats
            await reply(withFooter([
                `╔══════════════════════════╗`,
                `  📊 *Bot Statistics*`,
                `╚══════════════════════════╝`,
                ``,
                `🟢 *Status:*           Online`,
                `⏱  *Uptime:*           ${uptimeStr}`,
                `🕐 *SL Time:*          ${slNow.toUTCString().slice(0,25)} IST`,
                ``,
                `👥 *Registered:*       ${regCount}`,
                `🛡️  *Admins:*           ${db.admins.length + 1} (incl. super admin)`,
                `🚫 *Banned:*           ${db.banned.length}`,
                `📡 *Broadcasts:*       ${db.broadcasts.length}`,
                ``,
                `📦 *Students in DB:*   ${Object.keys(STUDENTS).length}`,
                `🔢 *Project Groups:*   ${allPGs}`,
                `🏘️  *WA Group Slots:*   ${slotCount}`,
                `👤 *Max per slot:*     ${MAX_STUDENTS_PER_GROUP}`,
                ``,
                `📅 *TT Groups:*        ${Object.keys(TIMETABLE).length}`,
                `💾 *Data path:*        ${DATA_PATH}`,
                `📬 *Broadcast queue:*  ${broadcastQueue.length} pending`,
            ].join('\n')));
            return;
        }

        // ── GROUPSTATUS ───────────────────────────────────────────────────────
        if (cmd === 'GROUPSTATUS') {
            if (!isAdmin(sid)) { await reply(withFooter('❌ *Not Authorized*')); return; }
            const allPGs = [...new Set(Object.values(STUDENTS).map(s => s.project_group))].sort();
            const lines  = [
                `╔══════════════════════════╗`,
                `  📊 *WA Group Status*`,
                `╚══════════════════════════╝`,
                ``,
            ];
            for (const pg of allPGs) {
                const slots = Object.keys(db.waGroups)
                    .filter(k => k === pg || k.startsWith(pg + '_'))
                    .sort();
                if (slots.length === 0) {
                    lines.push(`❌ ${pg}  (no group yet)`);
                } else {
                    for (const slot of slots) {
                        const count = registeredCountInSlot(slot);
                        const bar = '█'.repeat(count) + '░'.repeat(Math.max(0, MAX_STUDENTS_PER_GROUP - count));
                        lines.push(`✅ ${slot}  [${bar}] ${count}/${MAX_STUDENTS_PER_GROUP}`);
                    }
                }
            }
            const totalSlots = Object.keys(db.waGroups).length;
            lines.push(``, `📊 Slots: ${totalSlots} | Groups: ${allPGs.length}`);
            const full = withFooter(lines.join('\n'));
            // Split if too long (WhatsApp 4096 char limit)
            if (full.length < 4000) {
                await reply(full);
            } else {
                const half = Math.floor(lines.length / 2);
                await reply(withFooter(lines.slice(0, half).join('\n')));
                await sleep(800);
                await reply(withFooter(lines.slice(half).join('\n')));
            }
            return;
        }

        // ── CREATEALLGROUPS ───────────────────────────────────────────────────
        if (cmd === 'CREATEALLGROUPS') {
            if (!isSuperAdmin(sid)) { await reply(withFooter('❌ Super admin only.')); return; }
            const allPGs = [...new Set(Object.values(STUDENTS).map(s => s.project_group))].sort();
            const missing = allPGs.filter(pg => !db.waGroups[pg]);
            if (missing.length === 0) {
                await reply(withFooter('✅ All base groups already created!')); return;
            }
            await reply(withFooter(`🏗️ Creating *${missing.length}* groups...\nEst. time: ~${Math.ceil(missing.length * 3 / 60)} minutes.\nI'll send progress updates every 10 groups.`));
            let created = 0, failed = 0;
            for (let i = 0; i < missing.length; i++) {
                const pg = missing[i];
                const gid = await getOrCreateWAGroup(pg, pg);
                if (gid) created++; else failed++;
                // Progress update every 10 groups
                if ((i + 1) % 10 === 0 || i === missing.length - 1) {
                    try {
                        await sock.sendMessage(sid, {
                            text: withFooter(`⏳ Progress: ${i+1}/${missing.length}\n✔️ Created: ${created}  ❌ Failed: ${failed}`)
                        });
                    } catch(_) {}
                }
                await sleep(3000); // 3s between groups — safer rate
            }
            await reply(withFooter(`✅ *All Done!*\n✔️ Created: ${created}\n❌ Failed: ${failed}`));
            return;
        }

        // ── GROUPLINK ─────────────────────────────────────────────────────────
        if (cmd === 'GROUPLINK') {
            if (!isAdmin(sid)) { await reply(withFooter('❌ *Not Authorized*')); return; }
            if (!arg1) {
                await reply(withFooter(`❌ Usage: *GROUPLINK WD01*\nOr use GROUPLINK WD01_2 for overflow slots`));
                return;
            }
            const slotKey = arg1.toUpperCase();
            const wg = db.waGroups[slotKey];
            if (!wg) {
                await reply(withFooter(`❌ Slot *${slotKey}* not found.\nUse *GROUPSTATUS* to see all slots.`));
                return;
            }
            if (!wg.inviteLink) {
                try {
                    const code = await sock.groupInviteCode(wg.jid);
                    wg.inviteLink = `https://chat.whatsapp.com/${code}`;
                    saveDB();
                } catch(e) { await reply(withFooter(`❌ Could not fetch link: ${e.message}`)); return; }
            }
            const count = registeredCountInSlot(slotKey);
            await reply(withFooter([
                `🔗 *Group Link — ${slotKey}*`,
                ``,
                `📛 Name: ${wg.name}`,
                `👥 Members: ${count}/${MAX_STUDENTS_PER_GROUP}`,
                ``,
                `${wg.inviteLink}`,
                ``,
                `🆔 JID: ${wg.jid}`,
            ].join('\n')));
            return;
        }

        // ── ADDTOGROUP ────────────────────────────────────────────────────────
        if (cmd === 'ADDTOGROUP') {
            if (!isAdmin(sid)) { await reply(withFooter('❌ *Not Authorized*')); return; }
            if (!arg1) {
                await reply(withFooter(`❌ Usage: *ADDTOGROUP IT26XXXXXX*`));
                return;
            }
            const { key, data } = lookupStudent(arg1);
            if (!data) { await reply(withFooter(`❌ *${key}* not found.`)); return; }
            const studentReg = db.students[key];
            if (!studentReg?.whatsapp) {
                await reply(withFooter([
                    `⚠️ *${key}* hasn't registered yet.`,
                    ``,
                    `To add manually, use:`,
                    `*ADDMEMBER ${key} 94XXXXXXXXX*`,
                ].join('\n')));
                return;
            }
            await reply(withFooter(`⏳ Adding *${key}* to group *${data.project_group}*...`));
            const result = await addStudentToGroup(studentReg.whatsapp, data.project_group, key);
            if (result.ok) {
                await reply(withFooter([
                    `✅ *Done!*`,
                    `📌 Slot: ${result.slot}`,
                    `🔧 Method: ${result.method}`,
                    result.link ? `🔗 ${result.link}` : '',
                ].filter(Boolean).join('\n')));
            } else {
                await reply(withFooter(`❌ Failed: ${result.reason} (slot: ${result.slot})`));
            }
            return;
        }

        // ── FIXREG ───────────────────────────────────────────────────────────
        if (cmd==='FIXREG') {
            if(!isSuperAdmin(sid)){await reply(withFooter('❌ Super Admin only'));return;}
            if(!arg1||!arg2){await reply(withFooter('❌ Usage: *FIXREG IT26XXXXXX 94XXXXXXXXX*'));return;}
            const itNum=arg1.toUpperCase(),phone=arg2.replace(/[^0-9]/g,''),newJid=phone+'@s.whatsapp.net';
            if(!STUDENTS[itNum]){await reply(withFooter('❌ Student ID not found: '+itNum));return;}
            for(const[j,id]of Object.entries(db.registrations)){if(id===itNum)delete db.registrations[j];}
            delete db.registrations[newJid];
            db.registrations[newJid]=itNum;
            if(db.students[itNum])db.students[itNum].whatsapp=newJid;
            saveDB();
            await reply(withFooter('✅ *Fixed!*\n\n🆔 '+itNum+'\n📱 '+phone+'\n\nStudent can now send MYINFO.'));
            try{await directSend(newJid,{text:withFooter('✅ Your registration was fixed by admin!\n\nSend *MYINFO* to verify.')});}catch(_){}
            return;
        }
        if (cmd==='RESETREG') {
            if(!isSuperAdmin(sid)){await reply(withFooter('❌ Super Admin only'));return;}
            if(!arg1){await reply(withFooter('❌ Usage: *RESETREG IT26XXXXXX* or *RESETREG 94XXXXXXXXX*'));return;}
            const q=arg1.toUpperCase();let rJid=null,rId=null;
            if(q.startsWith('IT')){for(const[j,id]of Object.entries(db.registrations)){if(id===q){rJid=j;rId=id;break;}}}
            else{const ph=arg1.replace(/[^0-9]/g,'');rJid=ph+'@s.whatsapp.net';rId=db.registrations[rJid];if(!rId){for(const[j,id]of Object.entries(db.registrations)){if(jidNum(j)===ph){rJid=j;rId=id;break;}}}}
            if(!rJid||!rId){await reply(withFooter('❌ No registration found for '+arg1));return;}
            delete db.registrations[rJid];
            if(db.students[rId]){delete db.students[rId].whatsapp;delete db.students[rId].registeredAt;}
            saveDB();
            await reply(withFooter('✅ *Cleared!*\n\n🆔 '+rId+'\n📱 '+jidNum(rJid)+'\n\nThey can re-register now.'));
            return;
        }
        if (cmd==='CLEARGROUP') {
            if(!isSuperAdmin(sid)){await reply(withFooter('❌ Super Admin only'));return;}
            if(!arg1){await reply(withFooter('❌ Usage: *CLEARGROUP WD01*'));return;}
            const sk=arg1.toUpperCase();
            if(!db.waGroups[sk]){await reply(withFooter('❌ Slot '+sk+' not found.'));return;}
            delete db.waGroups[sk];
            if(db.groupLinks){const bp=sk.includes('_')?sk.split('_')[0]:sk;if(db.groupLinks[bp]?.slotKey===sk)delete db.groupLinks[bp];}
            let n=0;for(const s of Object.values(db.students)){if(s.wa_group_slot===sk){delete s.wa_group_slot;n++;}}
            saveDB();
            await reply(withFooter('✅ *Group slot cleared!*\n\n📌 '+sk+'\n👥 Students reset: '+n));
            return;
        }
        if (cmd==='STUDENTS'||cmd==='REGLIST') {
            if(!isSuperAdmin(sid)){await reply(withFooter('❌ Super Admin only'));return;}
            const regs=Object.entries(db.registrations);
            if(regs.length===0){await reply(withFooter('⚠️ No students registered yet.'));return;}
            const byGroup={};
            for(const[jid,itNum]of regs){const pg=STUDENTS[itNum]?.project_group||'Unknown';if(!byGroup[pg])byGroup[pg]=[];byGroup[pg].push({jid,itNum,name:STUDENTS[itNum]?.name||itNum});}
            const lines=['╔══════════════════════════╗','  👥 *Registered Students ('+regs.length+')*','╚══════════════════════════╝',''];
            for(const pg of Object.keys(byGroup).sort()){lines.push('*'+pg+'* ('+byGroup[pg].length+')');for(const s of byGroup[pg])lines.push('  • '+s.itNum+' — '+s.name.split(' ').slice(0,2).join(' ')+' | '+jidNum(s.jid));lines.push('');}
            lines.push('Total: *'+regs.length+'* registered');
            const full=withFooter(lines.join('\n'));
            if(full.length<=4000){await reply(full);}else{const m=Math.floor(lines.length/2);await reply(withFooter(lines.slice(0,m).join('\n')));await sleep(800);await reply(withFooter(lines.slice(m).join('\n')));}
            return;
        }
        if (cmd==='GROUPS'||cmd==='GROUPSLIST') {
            if(!isSuperAdmin(sid)){await reply(withFooter('❌ Super Admin only'));return;}
            const slots=Object.entries(db.waGroups||{});
            if(slots.length===0){await reply(withFooter('⚠️ No WA groups created yet.'));return;}
            const lines=['╔══════════════════════════╗','  🏘️ *Created WA Groups ('+slots.length+')*','╚══════════════════════════╝',''];
            for(const[slot,wg]of slots.sort(([a],[b])=>a.localeCompare(b))){
                const mc=Object.values(db.students).filter(s=>s.wa_group_slot===slot).length;
                const st=wg.botLeft?'🚪 Bot left':wg.adminPromoted?'👑 Admin set':'⏳ Pending';
                lines.push('*'+slot+'* — '+(wg.name||slot));
                lines.push('  👥 '+mc+' members | '+st);
                lines.push('  🔗 '+(wg.inviteLink||'No link'));
                lines.push('  📅 '+(wg.createdAt||'').slice(0,10));
                lines.push('');
            }
            lines.push('Total: *'+slots.length+'* groups');
            const full=withFooter(lines.join('\n'));
            if(full.length<=4000){await reply(full);}else{const m=Math.floor(lines.length/2);await reply(withFooter(lines.slice(0,m).join('\n')));await sleep(800);await reply(withFooter(lines.slice(m).join('\n')));}
            return;
        }

        // ── LISTADMINS ────────────────────────────────────────────────────────
        if (cmd === 'LISTADMINS') {
            if (!isAdmin(sid)) { await reply(withFooter('❌ *Not Authorized*')); return; }
            const lines = [
                `🛡️ *Admin List*`,
                ``,
                `⭐ *Super Admin (God-Level):*`,
                `  ${SUPER_ADMIN}`,
            ];
            if (db.admins.length) {
                lines.push(``, `🛡️ *Admins:*`);
                db.admins.forEach(a => lines.push(`  • ${jidNum(a)}`));
            } else {
                lines.push(``, `_(No regular admins yet)_`);
            }
            await reply(withFooter(lines.join('\n')));
            return;
        }

        // ── LISTBANNED ────────────────────────────────────────────────────────
        if (cmd === 'LISTBANNED') {
            if (!isAdmin(sid)) { await reply(withFooter('❌ *Not Authorized*')); return; }
            await reply(withFooter(db.banned.length
                ? `🚫 *Banned Users:*\n${db.banned.map(a => '  • ' + jidNum(a)).join('\n')}`
                : `✅ No banned users.`));
            return;
        }

        // ── ADDADMIN ──────────────────────────────────────────────────────────
        if (cmd === 'ADDADMIN') {
            if (!isSuperAdmin(sid)) { await reply(withFooter('❌ *Super admin only.*')); return; }
            if (!arg1) { await reply(withFooter(`❌ Usage: *ADDADMIN 94XXXXXXXXX*`)); return; }
            const id = toJid(arg1);
            if (!db.admins.some(a => jidNum(a) === jidNum(id))) { db.admins.push(id); saveDB(); }
            await reply(withFooter(`✅ *${arg1}* is now an admin.\nThey can now use ADMINHELP commands.`));
            return;
        }

        // ── REMOVEADMIN ───────────────────────────────────────────────────────
        if (cmd === 'REMOVEADMIN') {
            if (!isSuperAdmin(sid)) { await reply(withFooter('❌ *Super admin only.*')); return; }
            if (!arg1) { await reply(withFooter(`❌ Usage: *REMOVEADMIN 94XXXXXXXXX*`)); return; }
            db.admins = db.admins.filter(a => jidNum(a) !== jidNum(arg1));
            saveDB();
            await reply(withFooter(`✅ *${arg1}* removed from admins.`));
            return;
        }

        // ── BAN ───────────────────────────────────────────────────────────────
        if (cmd === 'BAN') {
            if (!isAdmin(sid)) { await reply(withFooter('❌ *Not Authorized*')); return; }
            if (!arg1) { await reply(withFooter(`❌ Usage: *BAN 94XXXXXXXXX*`)); return; }
            const id = toJid(arg1);
            if (isSuperAdmin(id)) { await reply(withFooter('❌ Cannot ban the super admin.')); return; }
            if (!db.banned.some(b => jidNum(b) === jidNum(id))) { db.banned.push(id); saveDB(); }
            await reply(withFooter(`🚫 *${arg1}* has been banned.`));
            return;
        }

        // ── UNBAN ─────────────────────────────────────────────────────────────
        if (cmd === 'UNBAN') {
            if (!isAdmin(sid)) { await reply(withFooter('❌ *Not Authorized*')); return; }
            if (!arg1) { await reply(withFooter(`❌ Usage: *UNBAN 94XXXXXXXXX*`)); return; }
            db.banned = db.banned.filter(b => jidNum(b) !== jidNum(arg1));
            saveDB();
            await reply(withFooter(`✅ *${arg1}* has been unbanned.`));
            return;
        }

        // ── BROADCAST ─────────────────────────────────────────────────────────
        if (cmd === 'BROADCAST') {
            if (!isAdmin(sid)) { await reply(withFooter('❌ *Not Authorized*')); return; }
            if (!rest) {
                await reply(withFooter([
                    `❌ *Missing Message*`,
                    ``,
                    `Usage: *BROADCAST <your message>*`,
                    ``,
                    `Example: BROADCAST Classes are cancelled tomorrow.`,
                ].join('\n')));
                return;
            }
            const targets = Object.keys(db.registrations);
            if (!targets.length) { await reply(withFooter('⚠️ No registered users to broadcast to.')); return; }
            const estMins = Math.ceil(targets.length * 0.8 / 60);
            await reply(withFooter(
                `📡 *Broadcast started* for *${targets.length}* users\n` +
                `⏱ Est. ~${estMins} minute${estMins !== 1 ? 's' : ''} (running in background)\n` +
                `✅ You can use other commands while it runs.`
            ));
            let sent = 0, failed = 0;
            const broadcastText = withFooter(`📢 *Announcement*\n\n${rest}`);
            // Run in background — Lane B queue, does NOT block admin replies
            const broadcastJob = (async () => {
                for (const t of targets) {
                    await enqueueBroadcast(t, { text: broadcastText })
                        .then(() => sent++)
                        .catch(() => failed++);
                }
                db.broadcasts.push({ message: rest, by: jidNum(sid), at: nowISO(), sent, failed });
                saveDB();
                try {
                    await directSend(sid, {
                        text: withFooter(`✅ *Broadcast Complete*\n✔️ Sent: ${sent}\n❌ Failed: ${failed}`)
                    });
                } catch(_) {}
            })();
            // Don't await — let it run in background
            broadcastJob.catch(e => console.error('Broadcast error:', e.message));
            return;
        }

        // ── Unknown command ────────────────────────────────────────────────────
        if (parts.length === 1 && cmd.length < 20) {
            await reply(withFooter([
                `❓ *Unknown Command: "${cmd}"*`,
                ``,
                `Send *HELP* to see all available commands.`,
            ].join('\n')));
        }

    } catch(e) {
        console.error(`❌ processMessage error: ${e.message}`, e.stack);
    }
}

// ─── HEALTH WATCHDOG ─────────────────────────────────────────────────────────
// Checks every 3 minutes if bot is stuck (connected but not processing).
// If sock exists but bot is not ready for >5 minutes, force a restart.
let lastActivityAt = Date.now();

// Call this whenever a message is received or sent
function touchActivity() { lastActivityAt = Date.now(); }

setInterval(() => {
    const msSinceActivity = Date.now() - lastActivityAt;
    // If bot claims to be ready but has had no activity for 10 min, ping WA
    if (botReady && msSinceActivity > 10 * 60 * 1000) {
        console.warn('🐕 Watchdog: no activity for 10min — pinging WhatsApp');
        if (sock) {
            sock.sendPresenceUpdate('available').catch(() => {
                console.warn('🐕 Watchdog: ping failed — triggering reconnect');
                if (sock) { try { sock.end(); } catch(_) {} }
            });
        }
        lastActivityAt = Date.now(); // reset so we don't ping every 3min
    }
}, 3 * 60 * 1000);

// ═══════════════════════════════════════════════════════════════════════════════
// BAILEYS INIT
// ═══════════════════════════════════════════════════════════════════════════════
async function startBot() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState(AUTH_PATH);
        let version;
        try {
            ({ version } = await fetchLatestBaileysVersion());
        } catch(e) {
            console.warn('⚠️  Baileys version fetch failed, using fallback:', e.message);
            version = [2, 3000, 1023561475];
        }
        console.log(`🔌 Baileys version: ${version.join('.')}`);

        sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            logger: P({ level: 'silent' }),
            // Randomize browser name slightly to reduce fingerprinting
            browser: ['SLIIT-Bot', 'Chrome', `120.0.${Math.floor(Math.random()*9000)+1000}`],
            generateHighQualityLinkPreview: false,
            syncFullHistory: false,
            // Performance & stability tuning
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 25000,   // ping WA every 25s to keep alive
            retryRequestDelayMs: 1500,
            maxMsgRetryCount: 5,          // retry failed message sends up to 5x
            fireInitQueries: true,
            getMessage: async (key) => {
                return { conversation: '' };
            },
        });

        // Bind store to socket events — populates contacts (LID→phone mappings)
        store.bind(sock.ev);

        sock.ev.on('creds.update', saveCreds);

        // Build LID→phone map from contacts sync (critical for reply routing)
        sock.ev.on('contacts.upsert', (contacts) => {
            for (const c of contacts) {
                if (c.id && c.lid) {
                    lidToPhone.set(c.lid, c.id);
                    console.log(`📇 LID mapped: ${c.lid} → ${c.id}`);
                }
            }
        });
        sock.ev.on('contacts.update', (updates) => {
            for (const c of updates) {
                if (c.id && c.lid) {
                    lidToPhone.set(c.lid, c.id);
                }
            }
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                latestQR  = qr;
                botStatus = 'qr';
                qrAttempts++;
                console.log(`📲 QR ready (attempt ${qrAttempts}) — visit http://<your-ip>:8080 to scan`);
                // QR auto-refreshes on the web page every 30s — no action needed here.
                // The bot keeps generating new QRs until scanned.
            }

            if (connection === 'open') {
                reconnectAttempts = 0;
                qrAttempts = 0;
                latestQR  = null;
                botStatus = 'stabilizing';
                console.log('🔗 Connection open — waiting 4s for session to stabilize...');
                // Give WhatsApp 4s to finish crypto handshake after reconnect
                await sleep(4000);
                botReady      = true;
                botStatus     = 'ready';
                sessionStableAt = Date.now();
                console.log('✅ Bot READY');
                // Set bot profile picture
                try {
                    const picPath = path.join(__dirname, 'IMG_5944.PNG');
                    if (fs.existsSync(picPath)) {
                        await sock.updateProfilePicture(sock.user.id, fs.readFileSync(picPath));
                        console.log('🖼️  Profile picture updated');
                    }
                } catch(e) { console.warn('⚠️  Profile pic error:', e.message); }
                try {
                    const slotCount = Object.keys(db.waGroups).length;
                    const allPGs    = [...new Set(Object.values(STUDENTS).map(s => s.project_group))].length;
                    await directSend(toJid(SUPER_ADMIN), {
                        text: withFooter([
                            `✅ *SLIIT Bot Online*`,
                            ``,
                            `💾 Data: ${DATA_PATH}`,
                            `👥 Registered: ${Object.keys(db.registrations).length}`,
                            `🏘️  WA Group Slots: ${slotCount} (${allPGs} project groups)`,
                            `📅 Timetable Groups: ${Object.keys(TIMETABLE).length}`,
                            ``,
                            `Send *ADMINHELP* for commands.`,
                        ].join('\n'))
                    });
                } catch(_) {}
            }

            if (connection === 'close') {
                botReady  = false;
                botStatus = 'disconnected';
                const code = lastDisconnect?.error?.output?.statusCode
                    ?? lastDisconnect?.error?.output?.payload?.statusCode;
                const reason = Object.keys(DisconnectReason).find(k => DisconnectReason[k] === code) || code;
                console.warn(`⚠️  Disconnected — code: ${code}, reason: ${reason}`);

                // ── Helper: clear auth and restart to show fresh QR ───────────
                const clearAndRestart = (label, delay = 3000) => {
                    console.log(`🔄 ${label} — clearing auth, restarting in ${delay/1000}s...`);
                    try { fs.rmSync(AUTH_PATH, { recursive: true, force: true }); } catch(_) {}
                    fs.mkdirSync(AUTH_PATH, { recursive: true });
                    qrAttempts = 0;
                    setTimeout(startBot, delay);
                };

                // 403 = permanently banned account
                if (code === 403) {
                    console.error('🚫 Account BANNED (403) — clearing session.');
                    botStatus = 'banned';
                    clearAndRestart('Banned — QR for new number');
                    return;
                }

                // 401 / loggedOut = user logged the bot out from their phone
                if (code === 401 || code === DisconnectReason.loggedOut) {
                    console.warn('🔑 Logged out — auto-generating new QR');
                    botStatus = 'logged_out';
                    clearAndRestart('Logged out — auto QR');
                    return;
                }

                // 408 / timedOut = connection timeout — reconnect immediately
                if (code === 408) {
                    console.warn('⏱️  Connection timed out — reconnecting immediately');
                    setTimeout(startBot, 1000);
                    return;
                }

                // 515 = restartRequired — WhatsApp server asked us to restart
                if (code === 515) {
                    console.warn('🔁 Restart required by WhatsApp server');
                    setTimeout(startBot, 2000);
                    return;
                }

                // All other disconnects — exponential backoff (max 60s)
                reconnectAttempts++;
                const delay = Math.min(3000 * Math.pow(1.5, reconnectAttempts - 1), 60000);
                console.log(`🔄 Reconnecting in ${(delay/1000).toFixed(1)}s (attempt ${reconnectAttempts})...`);
                setTimeout(startBot, delay);
            }
        });

        sock.ev.on('messages.upsert', handleMessage);

    } catch(e) {
        console.error('💥 startBot error:', e.message);
        reconnectAttempts++;
        setTimeout(startBot, Math.min(5000 * reconnectAttempts, 60000));
    }
}

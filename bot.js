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

// ─── BAILEYS IN-MEMORY STORE (LID → phone JID resolution) ────────────────────
// The store tracks contacts and their LID↔phone mappings automatically.
const store = { contacts: {}, loadMessage: async () => null, bind: () => {} };
const lidToPhone = new Map();

/**
 * Resolve a @lid JID to its real @s.whatsapp.net phone JID.
 * Falls back to the original JID if no mapping found.
 */
async function resolveLID(jid) {
    if (!jid) return jid;
    if (!jid.endsWith('@lid')) return jid;  // already a phone JID

    // 1. Check our LID→phone map (built from contacts.upsert events)
    if (lidToPhone.has(jid)) {
        const phone = lidToPhone.get(jid);
        console.log(`🔁 LID resolved: ${jid} → ${phone}`);
        return phone;
    }

    // 2. Try jidNormalizedUser as a hint
    try {
        const normalized = jidNormalizedUser(jid);
        if (normalized && !normalized.endsWith('@lid')) {
            console.log(`🔁 LID normalized: ${jid} → ${normalized}`);
            return normalized;
        }
    } catch(_) {}

    // 3. Reply directly to @lid — WhatsApp accepts it
    console.warn(`⚠️  Could not resolve LID ${jid} — replying to LID directly`);
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
async function directSend(jid, content, retries = 3) {
    if (!sock) {
        console.error(`❌ directSend: sock is null — bot not connected`);
        throw new Error('sock is null');
    }
    // Only wait if we reconnected very recently (< 3s ago)
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
            console.warn(`⚠️  directSend attempt ${attempt + 1} failed: ${e.message} — retrying in ${(attempt + 1)}s`);
            await sleep(1000 * (attempt + 1));
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
            if (job.retries < 2) {
                job.retries++;
                broadcastQueue.unshift(job);
                await sleep(4000 * job.retries);
            } else {
                job.reject(e);
            }
        }
        await sleep(800); // safe rate for bulk sends
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
const isSuperAdmin = jid => jidNum(jid) === jidNum(SUPER_ADMIN);
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
function withFooter(text) {
    return text + BOT_FOOTER;
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

// ─── RATE LIMITER ─────────────────────────────────────────────────────────────
// Prevents WhatsApp spam bans by limiting how fast the bot replies.
// - Per-user: max 3 commands per 10 seconds (protects against accidental spam)
// - Global outbound: min 600ms between any two sent messages
// Admins and super admin are exempt from per-user rate limits.
const rateLimitMap = new Map();   // jid → { count, windowStart }
const RATE_LIMIT_MAX    = 3;      // max commands per window
const RATE_LIMIT_WINDOW = 10000;  // 10 seconds

let lastSentAt = 0;  // global last-send timestamp
const MIN_SEND_GAP = 600;  // ms between outbound messages

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

// Throttle outbound sends — enforces MIN_SEND_GAP between messages globally
async function throttledSend(jid, content) {
    const now = Date.now();
    const wait = MIN_SEND_GAP - (now - lastSentAt);
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

        const ts = Number(msg.messageTimestamp) * 1000;
        if (Date.now() - ts > 600000) return;  // skip messages older than 10 min (covers Railway deploy time)

        if (!botReady) {
            console.log(`⏸  Bot not ready (${botStatus}) — ignoring ${jidNum(jid)}`);
            return;
        }

        // Rate limit check — drop silently if exceeded (no reply to avoid further sends)
        if (isRateLimited(jid)) return;

        // Dispatch to per-user queue (serializes concurrent messages from same user)
        enqueueForUser(jid, () => processMessage(jid, msg, body));

    } catch(e) {
        console.error(`❌ handleMessage error: ${e.message}`, e.stack);
    }
}

async function processMessage(jid, msg, body) {
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
        if (cmd === 'HELP' || cmd === 'HI' || cmd === 'HELLO' || cmd === 'START') {
            const reg  = db.registrations[sid];
            const name = reg ? STUDENTS[reg]?.name?.split(' ')[0] : null;
            const greeting = name ? `👋 Hi, *${name}!*` : `👋 *Welcome to SLIIT Y1S1 Bot!*`;
            const lines = [
                `╔═══════════════════════════╗`,
                `  🤖 *SLIIT Y1S1 Assistant*`,
                `╚═══════════════════════════╝`,
                ``,
                greeting,
                ``,
                `━━━━ 📌 *Start Here* ━━━━`,
                ``,
                `*REG IT26XXXXXX*`,
                `  Register & get your profile`,
                ``,
                `━━━━ 👤 *My Profile* ━━━━`,
                ``,
                `*MYINFO*       Your student profile`,
                `*MYGROUPS*     Timetable & project group`,
                `*MYLINK*       WhatsApp group invite link`,
                `*CLASSMATES*   Who's in your project group`,
                ``,
                `━━━━ 📅 *Timetable* ━━━━`,
                ``,
                `*TODAY*           Today's classes`,
                `*TOMORROW*        Tomorrow's classes`,
                `*NEXT*            Your next class right now`,
                `*WEEK*            Weekly class overview`,
                `*TT <day>*        E.g.  TT Friday`,
                ``,
                `━━━━ 🔍 *Search* ━━━━`,
                ``,
                `*INFO IT26XXXXXX*    Any student's details`,
                `*SEARCH <name>*      Search by name`,
                ``,
                `━━━━ ℹ️ *About* ━━━━`,
                ``,
                `🤖 *Created by Poojana Kaveesh*`,
                `🆔 IT26101524  |  📱 94772197530`,
            ];
            if (isAdmin(sid)) lines.push(``, `🛡️ *Admin:* Send *ADMINHELP* for admin commands.`);
            await reply(withFooter(lines.join('\n')));
            return;
        }

        // ── REG ───────────────────────────────────────────────────────────────
        if (cmd === 'REG') {
            if (!arg1) {
                await reply(withFooter([
                    `❌ *Missing Registration Number*`,
                    ``,
                    `📝 *How to register:*`,
                    `Send: *REG IT26XXXXXX*`,
                    ``,
                    `Example: REG IT26101700`,
                ].join('\n')));
                return;
            }
            const { key, data } = lookupStudent(arg1);
            if (!data) {
                await reply(withFooter([
                    `❌ *Student Not Found*`,
                    ``,
                    `🆔 Searched for: *${key}*`,
                    ``,
                    `Please double-check your IT number.`,
                    `If the problem persists, contact admin.`,
                    `📱 Support: 94772197530`,
                ].join('\n')));
                return;
            }

            const clash = Object.entries(db.registrations)
                .find(([w, it]) => it === key && jidNum(w) !== jidNum(sid));
            if (clash) {
                await reply(withFooter([
                    `⚠️ *Registration Conflict*`,
                    ``,
                    `*${key}* is already registered to a different WhatsApp number.`,
                    `If this is your account, contact admin to fix it.`,
                    `📱 Support: 94772197530`,
                ].join('\n')));
                return;
            }

            const alreadyRegistered = db.registrations[sid] === key;

            db.registrations[sid] = key;
            db.students[key] = { ...data, whatsapp: sid, registeredAt: nowISO() };
            saveDB();

            // Ask for group join confirmation instead of auto-adding
            const groupPrompt = await askGroupJoinConfirmation(sid, data, key);

            await reply(
                withFooter(
                    (alreadyRegistered ? `🔄 *Re-registered Successfully!*` : `🎉 *Registration Complete!*`) +
                    `\n\n` + fmtStudent(key, data) + groupPrompt +
                    `\n\n💡 Send *HELP* to see all available commands.`
                )
            );
            return;
        }

        // ── INFO ──────────────────────────────────────────────────────────────
        if (cmd === 'INFO') {
            if (!arg1) {
                await reply(withFooter([
                    `❌ *Missing Student ID*`,
                    ``,
                    `📝 Usage: *INFO IT26XXXXXX*`,
                    `Example:  INFO IT26101700`,
                ].join('\n')));
                return;
            }
            const { key, data } = lookupStudent(arg1);
            if (!data) {
                await reply(withFooter(`❌ *${key}* not found in the database.`));
                return;
            }
            let txt = fmtStudent(key, data);
            if (isAdmin(sid) && db.students[key]?.whatsapp) {
                txt += `\n📱 *WhatsApp:* ${jidNum(db.students[key].whatsapp)}`;
                txt += `\n🕒 *Registered:* ${db.students[key].registeredAt?.slice(0,10) || 'N/A'}`;
                if (db.students[key].addedBy) txt += `\n🛡️  *Added By:*  ${db.students[key].addedBy}`;
            }
            await reply(withFooter(txt));
            return;
        }

        // ── MYINFO ────────────────────────────────────────────────────────────
        if (cmd === 'MYINFO') {
            const reg = db.registrations[sid];
            if (!reg) {
                await reply(withFooter([
                    `⚠️ *Not Registered Yet*`,
                    ``,
                    `To register, send:`,
                    `*REG IT26XXXXXX*`,
                    ``,
                    `Replace IT26XXXXXX with your IT number.`,
                ].join('\n')));
                return;
            }
            const info = STUDENTS[reg];
            if (!info) { await reply(withFooter(`❌ Student data error. Contact admin.`)); return; }
            const slHour = new Date(Date.now() + 5.5 * 3600000).getUTCHours();
            const timeGreet = slHour < 12 ? '🌅 Good morning' : slHour < 17 ? '☀️ Good afternoon' : '🌙 Good evening';
            const firstName = info.name.split(' ')[0];
            const regDate = db.students[reg]?.registeredAt?.slice(0,10) || 'N/A';
            await reply(withFooter([
                `${timeGreet}, *${firstName}!* 👋`,
                ``,
                fmtStudent(reg, info),
                ``,
                `📅 *Registered:* ${regDate}`,
                ``,
                `💡 Try: *TODAY* · *NEXT* · *CLASSMATES*`,
            ].join('\n')));
            return;
        }

        // ── MYGROUPS ──────────────────────────────────────────────────────────
        if (cmd === 'MYGROUPS') {
            const reg = db.registrations[sid];
            if (!reg) {
                await reply(withFooter(`⚠️ *Not Registered*\n\nSend *REG IT26XXXXXX* to register first.`));
                return;
            }
            const s    = STUDENTS[reg];
            if (!s) { await reply(withFooter(`❌ Student data error. Contact admin.`)); return; }
            const pg   = s.project_group;
            const slot = db.students[reg]?.wa_group_slot || pg;
            const wg   = db.waGroups[slot];
            const memberCount = wg ? registeredCountInSlot(slot) : 0;
            const isWE = s.timetable_group.includes('WE');
            await reply(withFooter([
                `╔══════════════════════════╗`,
                `  📊 *My Groups – ${reg}*`,
                `╚══════════════════════════╝`,
                ``,
                `🗓️  *Schedule:*   ${isWE ? '🌅 Weekend' : '📆 Weekday'}`,
                `📚 *TT Group:*   ${s.timetable_group}`,
                `📌 *Sub-Group:*  ${s.sub_group}`,
                `🔢 *Project:*    ${pg}`,
                ``,
                wg
                    ? `🏘️  *WA Group:*   ${slot}\n👥 *Members:*   ${memberCount}/${MAX_STUDENTS_PER_GROUP}\n🔗 ${wg.inviteLink || '(link unavailable)'}`
                    : `⚠️  *WA Group:*   Not created yet\nSend *REG ${reg}* to trigger creation`,
            ].join('\n')));
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
            const jidTarget = toJid(waNum);
            const reg = db.registrations[jidTarget];
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
            browser: ['SLIIT Bot', 'Chrome', '1.0.0'],
            generateHighQualityLinkPreview: false,
            syncFullHistory: false,
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 30000,
            retryRequestDelayMs: 2000,
            getMessage: async (key) => {
                const stored = await store.loadMessage(key.remoteJid, key.id);
                return stored?.message || { conversation: '' };
            },
        });

        // Bind store to socket events — populates contacts (LID→phone mappings)
        store.bind(sock.ev);

        sock.ev.on('creds.update', saveCreds);

        // Build LID→phone map from contacts sync
        sock.ev.on('contacts.upsert', (contacts) => {
            for (const c of contacts) {
                if (c.id && c.lid) {
                    lidToPhone.set(c.lid, c.id);
                    console.log(`📇 LID mapped: ${c.lid} → ${c.id}`);
                }
                if (c.id && c.id.endsWith('@lid') && c.notify) {
                    // some versions swap id/lid
                    lidToPhone.set(c.id, c.notify);
                }
            }
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                latestQR  = qr;
                botStatus = 'qr';
                qrAttempts++;
                console.log(`📲 QR ready (attempt ${qrAttempts}) — open your Railway public URL to scan`);
                // If QR keeps cycling without being scanned, the session is invalid.
                // Stop looping — admin must visit the web page to scan.
                if (qrAttempts >= 3) {
                    console.warn(`⚠️  QR not scanned after ${qrAttempts} attempts — pausing reconnect loop.`);
                    console.warn(`👉 Visit your Railway public URL to scan the QR code.`);
                    // Don't reconnect — wait for manual scan via the web page
                    // The QR is still displayed on the web page
                }
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

                // 403 = account permanently banned — clear auth and show QR for new number
                if (code === 403) {
                    console.error('🚫 Account BANNED (403) — clearing auth session. Re-link with a new number via the web page.');
                    try { fs.rmSync(AUTH_PATH, { recursive: true, force: true }); } catch(_) {}
                    fs.mkdirSync(AUTH_PATH, { recursive: true });
                    botStatus = 'banned_cleared';
                    qrAttempts = 0;
                    console.log('🔄 Auth cleared — restarting to show QR for new number...');
                    setTimeout(startBot, 3000);
                    return;
                }

                if (code === DisconnectReason.loggedOut) {
                    console.log('🔑 Logged out — clearing auth');
                    try { fs.rmSync(AUTH_PATH, { recursive: true, force: true }); } catch(_) {}
                    fs.mkdirSync(AUTH_PATH, { recursive: true });
                    botStatus = 'logged_out';
                    qrAttempts = 0;
                    setTimeout(startBot, 3000);
                    return;
                }

                reconnectAttempts++;
                const delay = Math.min(5000 * reconnectAttempts, 60000);
                console.log(`🔄 Reconnecting in ${delay / 1000}s (attempt ${reconnectAttempts})...`);
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

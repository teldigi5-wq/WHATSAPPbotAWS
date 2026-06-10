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

        // Detect reply to AI message for conversation continuation
        const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        const quotedText = quotedMsg?.conversation || quotedMsg?.extendedTextMessage?.text || '';
        const isReplyToAI = quotedText.includes('Assistant') && (quotedText.includes('Answer:') || quotedText.includes('Turn') || quotedText.includes('💡'));

        const parts = body.trim().split(/\s+/);
        const cmd   = parts[0].replace(/^\//, '').toUpperCase();
        const arg1  = parts[1] || '';
        const arg2  = parts[2] || '';
        const rest  = parts.slice(1).join(' ');

        console.log(`📨 ${jidNum(jid)} → ${body.trim().slice(0, 80)}`);

        if (isBanned(sid)) { console.log(`🚫 Banned user: ${jidNum(sid)}`); return; }

        // ── ENDCHAT ───────────────────────────────────────────────────────────
        if (body.trim().toUpperCase() === 'ENDCHAT') {
            const lang = getLang(sid);
            if (aiConversations.has(sid)) {
                const turns = Math.floor((aiConversations.get(sid).history?.length||0)/2);
                aiConversations.delete(sid);
                await reply(withFooter(lang==='si'
                    ? `✅ *AI සංවාදය අවසන්!*

📊 ප්‍රශ්න ${turns}ක් අසන ලදී.

නව ප්‍රශ්නයක් සඳහා *ASK <ප්‍රශ්නය>*`
                    : `✅ *AI chat session ended!*

📊 You asked ${turns} question(s).

Start new: *ASK <question>*`
                ));
            } else {
                await reply(withFooter(lang==='si' ? '⚠️ සක්‍රිය AI සංවාදයක් නොමැත.' : '⚠️ No active AI chat session.'));
            }
            return;
        }

        // ── AI REPLY CONTINUATION ─────────────────────────────────────────────────
        if (isReplyToAI && body.trim() && body.trim().toUpperCase() !== 'ENDCHAT') {
            const lang = getLang(sid);
            const session = aiConversations.get(sid);
            const question = body.trim();
            const reg = db.registrations[sid];
            const stuName = reg ? STUDENTS[reg]?.name?.split(' ')[0] : 'Student';
            const provKey = session?.providerKey || getAIProvider(sid);
            const prov = AI_PROVIDERS[provKey];
            const history = session?.history ? [...session.history] : [];
            // Add the new question to history
            history.push({ role: 'user', content: question });
            await reply(withFooter(`⏳ *${prov.emoji} ${prov.name} is thinking...*`));
            try {
                const sys = `You are a helpful academic assistant for SLIIT Year 1 Semester 1 students. Student: ${stuName}. Answer concisely under 350 words. Format code with backticks. Reply in Sinhala if asked in Sinhala. This is a continuing conversation - maintain context.`;
                const answer = await prov.call(question, sys, history.slice(-8));
                history.push({ role: 'assistant', content: answer });
                aiConversations.set(sid, { history: history.slice(-12), lastActivity: Date.now(), providerKey: provKey });
                const turn = Math.floor(history.length/2);
                await reply(withFooter(`${prov.emoji} *${prov.name}* (Turn ${turn})

❓ *${question}*

💡 *Answer:*
${answer}

_💬 Reply to continue | *ENDCHAT* to end_`));
            } catch(e) {
                console.error('AI continuation error:', e.message);
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
                    `╔═══════════════════════════╗`,
                    `  🤖 *SLIIT Y1S1 සහායක*`,
                    `╚═══════════════════════════╝`,
                    ``,
                    greet,
                    greeting,
                    ``,
                    `💬 _${quote}_`,
                    ``,
                    `━━━━ 📌 *ආරම්භ කරන්න* ━━━━`,
                    ``,
                    `*REG IT26XXXXXX*`,
                    `  ඔබේ SLIIT IT අංකය යොදා ලියාපදිංචි වන්න`,
                    `  ඔබේ profile සහ group link ලබාගන්න`,
                    ``,
                    `━━━━ 👤 *මගේ Profile* ━━━━`,
                    ``,
                    `*MYINFO*      ඔබේ student profile බලන්න`,
                    `*MYGROUPS*    කාල සටහන සහ project group`,
                    `*MYLINK*      WhatsApp group invite link`,
                    `*CLASSMATES*  ඔබේ group එකේ සිටිනා අය`,
                    `*JOINGROUP WD01*  ඕනෑම group link`,
                    ``,
                    `━━━━ 📅 *කාල සටහන* ━━━━`,
                    ``,
                    `*TODAY*      අදට ඇති classes`,
                    `*TOMORROW*   හෙටට ඇති classes`,
                    `*NEXT*       ඊළඟ class එක`,
                    `*WEEK*       සතිය overview`,
                    `*TT Friday*  දිනය අනුව class`,
                    ``,
                    `━━━━ 🔍 *සෙවීම* ━━━━`,
                    ``,
                    `*INFO IT26XXXXXX*  ශිෂ්‍යයෙකුගේ details`,
                    `*SEARCH <නම>*      නමෙන් සෙවීම`,
                    ``,
                    `━━━━ 🤖 *AI සහායක* ━━━━`,
                    ``,
                    `*ASK <ප්‍රශ්නය>*  AI සහායකෙන් ප්‍රශ්නය අසන්න`,
                    `  උදා: ASK What is a database?`,
                    `  උදා: ASK Explain OOP in simple terms`,
                    ``,
                    `━━━━ 🌐 *භාෂාව* ━━━━`,
                    ``,
                    `*LANG EN*   Switch to English`,
                    `*LANG SI*   සිංහල (දැනට)`,
                    ``,
                    `━━━━ ℹ️ *ගැන* ━━━━`,
                    ``,
                    `📞 SLIIT Help Center: +94 11 754 4801`,
                    ``,
                    `⚠️ _මෙම bot එක SLIIT ආයතනය සමඟ සම්බන්ධ නොවේ_`,
                ];
            } else {
                lines = [
                    `╔═══════════════════════════╗`,
                    `  🤖 *SLIIT Y1S1 Assistant*`,
                    `╚═══════════════════════════╝`,
                    ``,
                    greet,
                    greeting,
                    ``,
                    `💬 _${quote}_`,
                    ``,
                    `━━━━ 📌 *Start Here* ━━━━`,
                    ``,
                    `*REG IT26XXXXXX*`,
                    `  Register using your SLIIT IT number`,
                    `  to unlock your profile & group link`,
                    ``,
                    `━━━━ 👤 *My Profile* ━━━━`,
                    ``,
                    `*MYINFO*      View your student profile`,
                    `*MYGROUPS*    Your timetable & project group`,
                    `*MYLINK*      Get your WhatsApp group link`,
                    `*CLASSMATES*  See who's in your project group`,
                    `*JOINGROUP WD01*  Get any group's invite link`,
                    ``,
                    `━━━━ 📅 *Timetable* ━━━━`,
                    ``,
                    `*TODAY*      Today's class schedule`,
                    `*TOMORROW*   Tomorrow's classes`,
                    `*NEXT*       Your next upcoming class`,
                    `*WEEK*       Full weekly timetable`,
                    `*TT Friday*  Timetable for a specific day`,
                    ``,
                    `━━━━ 🔍 *Search* ━━━━`,
                    ``,
                    `*INFO IT26XXXXXX*  Look up any student`,
                    `*SEARCH <name>*    Search students by name`,
                    ``,
                    `━━━━ 🤖 *AI Assistant* ━━━━`,
                    ``,
                    `*ASK <question>*  Ask the AI anything!`,
                    `  e.g. ASK What is a database?`,
                    `  e.g. ASK Explain OOP in simple terms`,
                    `  e.g. ASK Help me understand recursion`,
                    ``,
                    `━━━━ 🌐 *Language* ━━━━`,
                    ``,
                    `*LANG SI*   Switch to Sinhala / සිංහල`,
                    `*LANG EN*   English (current)`,
                    ``,
                    `━━━━ ℹ️ *About* ━━━━`,
                    ``,
                    `📞 *SLIIT Help Center:* +94 11 754 4801`,
                    ``,
                    `⚠️ _This bot is not associated with SLIIT operations_`,
                ];
            }
            if (isAdmin(sid)) lines.push(``, `🛡️ *${lang==='si'?'Admin:':'Admin:'} Send *ADMINHELP* for admin commands.`);
            await reply(withFooter(lines.join('\n')));
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

        // ── QUOTE — motivational quote ────────────────────────────────────────
        if (cmd === 'QUOTE' || cmd === 'MOTIVATE') {
            const lang = getLang(sid);
            const q = randomQuote(lang);
            await reply(withFooter(`💬 *${lang==='si'?'දිරිගැන්වීම':'Motivation'}*\n\n_${q}_`));
            return;
        }

        // ── ASK — AI assistant ────────────────────────────────────────────────
        if (cmd === 'ASK' || cmd === 'AI') {
            const lang = getLang(sid);
            const question = body.replace(/^(ASK|AI)\s*/i, '').trim();
            if (!question) {
                const usage = lang==='si'
                    ? '❌ *ප්‍රශ්නයක් යවන්න!*\n\nඋදා: *ASK What is a database?*\nඋදා: *ASK OOP explain කරන්න*'
                    : '❌ *Please include your question!*\n\nExample: *ASK What is a database?*\nExample: *ASK Explain recursion simply*';
                await reply(withFooter(usage));
                return;
            }
            const reg = db.registrations[sid];
            const stuName = reg ? STUDENTS[reg]?.name?.split(' ')[0] : 'Student';
            await reply(withFooter(lang==='si'
                ? `⏳ *AI සිතනවා...*\n\n"${question.slice(0,60)}${question.length>60?'...':''}" ගැන\n\nකරුණාකර රැඳී සිටින්න!`
                : `⏳ *AI is thinking...*\n\nLooking into: "${question.slice(0,60)}${question.length>60?'...':''}"\n\nPlease wait a moment!`
            ));
            try {
                const sysPrompt = `You are a helpful academic assistant for SLIIT (Sri Lanka Institute of Information Technology) Year 1 Semester 1 students. 
The student's name is ${stuName}. 
Answer questions about programming, databases, mathematics, IT concepts, and campus life.
Keep answers clear, concise and student-friendly.
Use simple English. If the question is in Sinhala, reply in Sinhala.
Format code blocks with backticks. Keep answers under 400 words.`;
                const resp = await fetch('https://api.anthropic.com/v1/messages', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model: 'claude-haiku-4-5-20251001',
                        max_tokens: 600,
                        system: sysPrompt,
                        messages: [{ role: 'user', content: question }]
                    })
                });
                const data = await resp.json();
                const answer = data?.content?.[0]?.text || 'Sorry, I could not get an answer.';
                const header = lang==='si'
                    ? `🤖 *AI සහායක*\n\n❓ *ප්‍රශ්නය:* ${question}\n\n💡 *පිළිතුර:*\n`
                    : `🤖 *AI Assistant*\n\n❓ *Question:* ${question}\n\n💡 *Answer:*\n`;
                const footer = lang==='si'
                    ? `\n\n_තවත් ප්‍රශ්නයක් ඇත්නම් *ASK <ප්‍රශ්නය>* යවන්න_`
                    : `\n\n_Ask another question with *ASK <question>*_`;
                await reply(withFooter(header + answer + footer));
            } catch(e) {
                console.error('❌ AI error:', e.message);
                await reply(withFooter(lang==='si'
                    ? '❌ *AI සේවාව දැන් ලබා ගත නොහැක.*\n\nපසුව නැවත උත්සාහ කරන්න.'
                    : '❌ *AI service unavailable right now.*\n\nPlease try again later.'
                ));
            }
            return;
        }

        // ── LANG ─────────────────────────────────────────────────────────────
        if (cmd === 'LANG') {
            if (!db.languages) db.languages = {};
            const ch = (arg1||'').toUpperCase();
            if (ch==='SI'||ch==='SINHALA') { db.languages[sid]='si'; saveDB(); await reply(withFooter('✅ *භාෂාව සිංහලට සකසන ලදී!*\n\n*HELP* යවන්න menu බලන්න.')); return; }
            if (ch==='EN'||ch==='ENGLISH') { db.languages[sid]='en'; saveDB(); await reply(withFooter('✅ *Language set to English!*\n\nSend *HELP* to see menu.')); return; }
            await reply(withFooter('🌐 *Choose language*\n\n*LANG EN* — 🇬🇧 English\n*LANG SI* — 🇱🇰 සිංහල'));
            return;
        }

        // ── SETAI ─────────────────────────────────────────────────────────────
        if (cmd === 'SETAI' || cmd === 'USEAI') {
            const lang = getLang(sid);
            const ch = (arg1||'').toLowerCase();
            if (!ch) {
                const cur = getAIProvider(sid);
                const lines = [lang==='si'?'🤖 *AI සේවාව තෝරන්න*':'🤖 *Select AI Provider*', '',
                    (lang==='si'?'දැනට: ':'Current: ') + AI_PROVIDERS[cur].emoji + ' *' + AI_PROVIDERS[cur].name + '*', '',
                    '*SETAI llama*     🦙 Llama 3.3 70B (recommended)',
                    '*SETAI gemini*    🟦 Google Gemma 2',
                    '*SETAI mistral*   ⚡ Mistral Saba',
                    '*SETAI deepseek*  🔬 DeepSeek R1',
                ];
                await reply(withFooter(lines.join('\n'))); return;
            }
            if (!AI_PROVIDERS[ch]) { await reply(withFooter('❌ Options: *SETAI llama* / *SETAI gemini* / *SETAI mistral* / *SETAI deepseek*')); return; }
            if (!db.aiProvider) db.aiProvider = {};
            db.aiProvider[sid] = ch; saveDB();
            await reply(withFooter('✅ *AI set to ' + AI_PROVIDERS[ch].emoji + ' ' + AI_PROVIDERS[ch].name + '!*\n\nUse *ASK <question>* to start.'));
            return;
        }

        // ── QUOTE ─────────────────────────────────────────────────────────────
        if (cmd === 'QUOTE' || cmd === 'MOTIVATE') {
            const lang = getLang(sid);
            await reply(withFooter(`💬 *${lang==='si'?'දිරිගැන්වීම':'Daily Motivation'}*\n\n_${randomQuote(lang)}_\n\n_Keep pushing! 💪_`));
            return;
        }

        // ── MYEAC — Show EAC group info ────────────────────────────────────────
        if (cmd === 'MYEAC' || cmd === 'EAC') {
            const lang = getLang(sid);
            const reg = db.registrations[sid];
            if (!reg) { await reply(withFooter(lang==='si'?'⚠️ ලියාපදිංචි වී නැත. *REG IT26XXXXXX* යවන්න.':'⚠️ Not registered. Send *REG IT26XXXXXX* first.')); return; }
            const eacGroup = EAC_GROUPS[reg];
            if (!eacGroup) { await reply(withFooter(lang==='si'?`⚠️ *${reg}* සඳහා EAC group data නොමැත.`:`⚠️ No EAC group data found for *${reg}*.`)); return; }
            const ttGroup = eacGroup.slice(0,2); // e.g. "01", "02"
            const subGroup = eacGroup.slice(2); // e.g. "A", "B"
            const groupName = `Y1.S1.WD.IT.${ttGroup}.${subGroup}`;
            const lines = [
                `╔══════════════════════════╗`,
                `  📚 *EAC Group Info*`,
                `╚══════════════════════════╝`,
                ``,
                `🆔 Student: *${reg}*`,
                ``,
                `📋 *EAC Group:* ${eacGroup}`,
                `📌 *Group Name:* ${groupName}`,
                ``,
                `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
                `💡 Your EAC class is group *${eacGroup}*`,
                `   (English for Academic Communication)`,
            ];
            await reply(withFooter(lines.join('\n')));
            return;
        }

        // ── ASK — Multi-AI with conversation memory ────────────────────────────
        if (cmd === 'ASK' || cmd === 'AI') {
            const lang = getLang(sid);
            const question = body.replace(/^(ASK|AI)\s*/i, '').trim();
            if (!question) {
                await reply(withFooter(lang==='si'
                    ? '❌ ප්‍රශ්නයක් යවන්න!\n\nඋදා: *ASK What is OOP?*\n\nAI change: *SETAI llama*'
                    : '❌ Include your question!\n\nExample: *ASK What is OOP?*\nSwitch AI: *SETAI llama*'
                ));
                return;
            }
            const reg = db.registrations[sid];
            const stuName = reg ? STUDENTS[reg]?.name?.split(' ')[0] : 'Student';
            const provKey = getAIProvider(sid);
            const prov = AI_PROVIDERS[provKey];
            // Build/continue session
            const existingSession = aiConversations.get(sid);
            const history = existingSession?.history ? [...existingSession.history] : [];
            history.push({ role: 'user', content: question });
            aiConversations.set(sid, { history: history.slice(-12), lastActivity: Date.now(), providerKey: provKey });
            await reply(withFooter(lang==='si'
                ? `⏳ *${prov.emoji} ${prov.name} සිතනවා...*\n\n"${question.slice(0,50)}" ගැන`
                : `⏳ *${prov.emoji} ${prov.name} is thinking...*\n\nLooking into: "${question.slice(0,50)}"`
            ));
            try {
                const sys = `You are a helpful academic assistant for SLIIT Year 1 Semester 1 students. Student: ${stuName}. Answer concisely under 350 words. Format code with backticks. Reply in Sinhala if asked in Sinhala. Maintain context from conversation history.`;
                const answer = await prov.call(question, sys, history.slice(-8));
                const updatedHistory = [...history, { role: 'assistant', content: answer }];
                aiConversations.set(sid, { history: updatedHistory.slice(-12), lastActivity: Date.now(), providerKey: provKey });
                const turn = Math.floor(updatedHistory.length/2);
                const header = lang==='si'
                    ? `${prov.emoji} *${prov.name} සහායක* (Turn ${turn})\n\n❓ *${question}*\n\n💡 *පිළිතුර:*\n`
                    : `${prov.emoji} *${prov.name} Assistant* (Turn ${turn})\n\n❓ *${question}*\n\n💡 *Answer:*\n`;
                const foot = lang==='si'
                    ? `\n\n_💬 Reply to continue | *ENDCHAT* end | *SETAI llama* change AI_`
                    : `\n\n_💬 *Reply* to this message to continue | *ENDCHAT* to end_`;
                await reply(withFooter(header + answer + foot));
            } catch(e) {
                console.error('AI error:', e.message);
                aiConversations.delete(sid);
                await reply(withFooter(lang==='si'
                    ? `❌ *${prov.name} ලබා ගත නොහැක.* *SETAI llama* try කරන්න.`
                    : `❌ *${prov.name} unavailable.* Try: *SETAI llama*`
                ));
            }
            return;
        }

        // ── IMAGE — AI image generation ────────────────────────────────────────
        if (cmd === 'IMAGE' || cmd === 'IMG' || cmd === 'IMAGINE') {
            const lang = getLang(sid);
            const prompt = body.replace(/^(IMAGE|IMG|IMAGINE)\s*/i, '').trim();
            if (!prompt) { await reply(withFooter(lang==='si'?'❌ *IMAGE futuristic SLIIT campus* ලෙස යවන්න':'❌ Example: *IMAGE futuristic SLIIT campus*')); return; }
            await reply(withFooter(lang==='si'?`⏳ *AI image generate කරනවා...*\n"${prompt.slice(0,50)}"\nරැඳී සිටින්න!⏳`:`⏳ *Generating AI image...*\n"${prompt.slice(0,50)}"\nPlease wait!`));
            try {
                const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=800&height=600&nologo=true&seed=${Date.now()}`;
                const resp = await fetch(imageUrl, { signal: AbortSignal.timeout(30000) });
                if (!resp.ok) throw new Error('Image fetch failed: ' + resp.status);
                const buffer = Buffer.from(await resp.arrayBuffer());
                await directSend(sid, { image: buffer, caption: withFooter(`🎨 *AI Generated Image*\n\n📝 Prompt: ${prompt}\n\n_Generate another: IMAGE <description>_`) });
            } catch(e) {
                console.error('Image error:', e.message);
                await reply(withFooter('❌ *Could not generate image.*\n\nTry a simpler description or try again later.'));
            }
            return;
        }

        // ── SLIDES — AI presentation maker ────────────────────────────────────
        if (cmd === 'SLIDES' || cmd === 'PPT' || cmd === 'PRESENTATION') {
            const lang = getLang(sid);
            const topic = body.replace(/^(SLIDES|PPT|PRESENTATION)\s*/i, '').trim();
            if (!topic) { await reply(withFooter(lang==='si'?'❌ *SLIDES Introduction to OOP* ලෙස යවන්න':'❌ Example: *SLIDES Introduction to OOP*')); return; }
            const prov = AI_PROVIDERS[getAIProvider(sid)];
            await reply(withFooter(`⏳ *${prov.emoji} Creating presentation...*\n\nTopic: "${topic.slice(0,50)}"`));
            try {
                const reg = db.registrations[sid];
                const stuName = reg ? STUDENTS[reg]?.name?.split(' ')[0] : 'Student';
                const prompt = `Create a university presentation outline for SLIIT student ${stuName} on: "${topic}"\n\nFormat:\n🎯 TITLE: [Title]\n\n📑 SLIDE 1: INTRODUCTION\n• [point]\n• [point]\nSpeaker notes: [notes]\n\n📑 SLIDE 2-7: [Continue with key topics]\n\n📑 FINAL SLIDE: CONCLUSION\n• Key takeaways\n\nKeep each slide to 3-4 bullet points.`;
                const answer = await prov.call(prompt, 'You are an expert presentation creator for university students.', []);
                if (answer.length > 3500) {
                    const mid = answer.indexOf('\n📑', Math.floor(answer.length/2));
                    await reply(withFooter(`📊 *AI Presentation - Part 1*\n${answer.slice(0, mid > 0 ? mid : Math.floor(answer.length/2))}`));
                    await sleep(1000);
                    await reply(withFooter(`📊 *AI Presentation - Part 2*\n${answer.slice(mid > 0 ? mid : Math.floor(answer.length/2))}\n\n_💡 Copy to Google Slides or PowerPoint!_`));
                } else {
                    await reply(withFooter(`📊 *AI Presentation*\n\n${answer}\n\n_💡 Copy to Google Slides or PowerPoint!_`));
                }
            } catch(e) {
                console.error('Slides error:', e.message);
                await reply(withFooter('❌ *Could not create presentation.* Try again later.'));
            }
            return;
        }

        // ── VIDEO — Find educational videos ───────────────────────────────────
        if (cmd === 'VIDEO' || cmd === 'YT' || cmd === 'YOUTUBE') {
            const lang = getLang(sid);
            const query = body.replace(/^(VIDEO|YT|YOUTUBE)\s*/i, '').trim();
            if (!query) { await reply(withFooter('❌ Example: *VIDEO OOP in Java*')); return; }
            const ytUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query + ' tutorial')}`;
            await reply(withFooter([
                `🎬 *Educational Videos*`,
                ``,
                `📚 Topic: *${query}*`,
                ``,
                `🔗 *Search Results:*`,
                ytUrl,
                ``,
                `💡 *Quick searches:*`,
                `• ${query} tutorial for beginners`,
                `• ${query} explained simply`,
                `• SLIIT ${query}`,
                ``,
                `_Tap the link to find videos!_`,
            ].join('\n')));
            return;
        }

        // ── QUIZ ANSWER HANDLER ───────────────────────────────────────────────
        if (quizSessions.has(sid) && !['QUIZ','MYEAC','ASK','HELP','MYINFO','SETAI','ENDCHAT','LANG'].includes(cmd)) {
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
                const result = await prov.call(checkPrompt, 'You are a strict but encouraging teacher. Evaluate student answers fairly.', []);
                const isCorrect = result.toUpperCase().includes('RESULT: CORRECT');
                const explanation = result.replace(/RESULT:[^\n]*/i, '').replace('EXPLANATION:', '').trim().replace('EXPLANATION:', '').trim();
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
                await reply(withFooter(`❌ Could not check answer. Try again.`));
            }
            return;
        }

        // ── MYEAC ─────────────────────────────────────────────────────────────
        if (cmd === 'MYEAC' || cmd === 'EAC') {
            const lang = getLang(sid);
            const reg = db.registrations[sid];
            if (!reg) { await reply(withFooter(lang==='si'?'⚠️ ලියාපදිංචි වී නැත. *REG IT26XXXXXX* යවන්න.':'⚠️ Not registered. Send *REG IT26XXXXXX* first.')); return; }
            const eacGroup = EAC_GROUPS[reg];
            if (!eacGroup) { await reply(withFooter(`⚠️ No EAC group found for *${reg}*. Contact admin.`)); return; }
            const ttNum = eacGroup.slice(0,2);
            const subGrp = eacGroup.slice(2);
            await reply(withFooter([
                `╔══════════════════════════╗`,
                `  📚 *EAC Group Info*`,
                `╚══════════════════════════╝`,
                ``,
                `🆔 Student: *${reg}*`,
                ``,
                `📋 *EAC Group:*    ${eacGroup}`,
                `📌 *Class Name:*   Y1.S1.WD.IT.${ttNum}.${subGrp}`,
                `📚 *Subject:*      English for Academic Communication`,
                ``,
                `💡 Your EAC class is in Group *${eacGroup}*`,
            ].join('\n')));
            return;
        }

        // ── QUIZ — Daily practice questions ───────────────────────────────────
        if (cmd === 'QUIZ' || cmd === 'PRACTICE' || cmd === 'Q') {
            const lang = getLang(sid);
            const category = (arg1||'').toLowerCase();
            const categories = ['english','grammar','ielts','speaking','java','python','html','coding','pseudo','all'];
            if (category && !categories.includes(category)) {
                await reply(withFooter([
                    `❓ *Quiz Categories:*`,
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
            await reply(withFooter(`⏳ *Generating quiz question...*`));
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
                const result = await prov.call(prompt, 'You are a university quiz creator. Create clear, educational questions.', []);
                const qMatch = result.match(/QUESTION:s*(.+)/i);
                const aMatch = result.match(/ANSWER:s*(.+)/i);
                const catMatch = result.match(/CATEGORY:s*(.+)/i);
                const diffMatch = result.match(/DIFFICULTY:s*(.+)/i);
                if (!qMatch || !aMatch) throw new Error('Bad format');
                const question = qMatch[1].trim();
                const answer = aMatch[1].trim();
                const detectedCat = catMatch?.[1]?.trim() || cat;
                const difficulty = diffMatch?.[1]?.trim() || 'medium';
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
                    `_Send *QUIZ* to skip & get new question_`,
                ].join('\n')));
            } catch(e) {
                console.error('Quiz error:', e.message);
                await reply(withFooter('❌ Could not generate question. Try *QUIZ english* or *QUIZ java*'));
            }
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

const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const port = 3000;

process.on('uncaughtException', err => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', (reason) => console.error('Unhandled Rejection:', reason));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/admin', express.static(path.join(__dirname, 'public')));

let qrCodeData    = null;
let clientReady   = false;
let clientSocket  = null;
let savedContacts = [];
let contactSyncTimers = [];

const historyFile = path.join(__dirname, 'sent_history.json');
let sendHistory = [];
if (fs.existsSync(historyFile)) {
  try { sendHistory = JSON.parse(fs.readFileSync(historyFile, 'utf8')); } catch(e) {}
}
const saveHistory = () => fs.writeFileSync(historyFile, JSON.stringify(sendHistory, null, 2));

const contactsFile = path.join(__dirname, 'contacts_cache.json');
if (fs.existsSync(contactsFile)) {
  try { savedContacts = JSON.parse(fs.readFileSync(contactsFile, 'utf8')); } catch(e) {}
}
const saveContacts = () => fs.writeFileSync(contactsFile, JSON.stringify(savedContacts, null, 2));

const invitationsFile = path.join(__dirname, 'invitations.json');
let invitations = [];
if (fs.existsSync(invitationsFile)) {
  try { invitations = JSON.parse(fs.readFileSync(invitationsFile, 'utf8')); } catch(e) {}
}
const saveInvitations = () => fs.writeFileSync(invitationsFile, JSON.stringify(invitations, null, 2));

// -------------------------------------------------------
// Baileys contact name sync helper
// -------------------------------------------------------
const APP_STATE_COLLECTIONS = ['critical_block', 'critical_unblock_low', 'regular_high', 'regular_low', 'regular'];

function scheduleContactNameSync(sock) {
  contactSyncTimers.forEach(clearTimeout);
  contactSyncTimers = [10000, 60000].map(ms => setTimeout(async () => {
    if (sock !== clientSocket) return;
    try {
      await sock.resyncAppState(APP_STATE_COLLECTIONS, true);
      const named = savedContacts.filter(c => c.name && c.name !== c.number).length;
      console.log(`Contact names resync done (+${ms / 1000}s). Con nombre: ${named}/${savedContacts.length}`);
    } catch (e) {
      console.error('Contact names resync failed:', e && e.message);
    }
  }, ms));
}

function upsertContact(wid, c) {
  const number = wid.split('@')[0];
  const name   = c.name || c.notify || c.verifiedName || number;
  const existing = savedContacts.find(x => x.id === wid);
  if (!existing) {
    savedContacts.push({ id: wid, name, number });
  } else if (name && name !== number && (!existing.name || existing.name === existing.number)) {
    existing.name = name;
  }
}

// -------------------------------------------------------
// WhatsApp connection
// -------------------------------------------------------
async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, 'baileys_auth_info'));

  clientSocket = makeWASocket({
    logger: pino({ level: 'info' }),
    printQRInTerminal: false,
    auth: state,
    version: [2, 3000, 1042466098],
    browser: ['Ubuntu', 'Chrome', '20.0.04'],
    syncFullHistory: true,
    shouldSyncHistoryMessage: () => true
  });

  clientSocket.ev.on('creds.update', saveCreds);

  clientSocket.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('QR RECEIVED');
      try { qrCodeData = await qrcode.toDataURL(qr); } catch (e) {}
      clientReady = false;
    }

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Connection closed. Reconnecting:', shouldReconnect);
      clientReady = false;
      qrCodeData  = null;
      if (shouldReconnect) {
        startWhatsApp();
      } else {
        fs.rmSync(path.join(__dirname, 'baileys_auth_info'), { recursive: true, force: true });
        startWhatsApp();
      }
    } else if (connection === 'open') {
      console.log('WhatsApp Client ready!');
      clientReady = true;
      qrCodeData  = null;
      scheduleContactNameSync(clientSocket);
    }
  });

  clientSocket.ev.on('contacts.upsert', (contacts) => {
    for (const c of contacts) {
      const wid = c.jid || c.id;
      if (wid && (wid.endsWith('@s.whatsapp.net') || wid.endsWith('@c.us'))) {
        upsertContact(wid, c);
      }
    }
    saveContacts();
  });

  clientSocket.ev.on('contacts.update', (updates) => {
    for (const u of updates) {
      const wid = u.id;
      if (wid) {
        const existing = savedContacts.find(x => x.id === wid);
        if (existing) {
          const newName = u.name || u.notify || u.verifiedName;
          if (newName && newName !== existing.number) existing.name = newName;
        }
      }
    }
    saveContacts();
  });

  clientSocket.ev.on('messaging-history.set', ({ contacts }) => {
    if (contacts && contacts.length > 0) {
      for (const c of contacts) {
        const wid = c.id;
        if (wid && (wid.endsWith('@s.whatsapp.net') || wid.endsWith('@c.us'))) {
          upsertContact(wid, c);
        }
      }
      saveContacts();
      console.log(`Loaded ${contacts.length} contacts from history sync`);
    }
  });
}

startWhatsApp();

// -------------------------------------------------------
// Auth middleware
// -------------------------------------------------------
const ADMIN_TOKEN = 'amelia-shower-token-2025';

const authenticate = (req, res, next) => {
  if (req.headers.authorization === `Bearer ${ADMIN_TOKEN}`) return next();
  res.status(401).json({ success: false, message: 'Unauthorized' });
};

// -------------------------------------------------------
// Admin auth
// -------------------------------------------------------
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === 'amanda' && password === 'ameliashower2025') {
    res.json({ success: true, token: ADMIN_TOKEN });
  } else {
    res.status(401).json({ success: false, message: 'Credenciales inválidas' });
  }
});

// -------------------------------------------------------
// WhatsApp status / logout
// -------------------------------------------------------
app.get('/api/whatsapp/status', authenticate, (req, res) => {
  if (clientReady)     res.json({ status: 'connected' });
  else if (qrCodeData) res.json({ status: 'qr', qrCode: qrCodeData });
  else                 res.json({ status: 'initializing' });
});

app.post('/api/whatsapp/logout', authenticate, async (req, res) => {
  clientReady = false;
  qrCodeData  = null;
  res.json({ success: true, message: 'Desconectado' });
  if (clientSocket) { try { await clientSocket.logout(); } catch(e) {} }
});

// -------------------------------------------------------
// Contacts
// -------------------------------------------------------
app.get('/api/whatsapp/contacts', authenticate, (req, res) => {
  if (fs.existsSync(contactsFile)) {
    try { savedContacts = JSON.parse(fs.readFileSync(contactsFile, 'utf8')); } catch(e) {}
  }
  const sorted = [...savedContacts].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  res.json({ success: true, contacts: sorted, count: sorted.length });
});

app.post('/api/whatsapp/import-contacts', authenticate, (req, res) => {
  const { text, contacts } = req.body;
  let addedCount = 0;

  if (Array.isArray(contacts)) {
    for (const c of contacts) {
      if (c.phone) {
        const cleanPhone = c.phone.toString().replace(/\D/g, '');
        const id = cleanPhone + '@s.whatsapp.net';
        const name = c.name || cleanPhone;
        const existing = savedContacts.find(x => x.id === id);
        if (!existing) { savedContacts.push({ id, name, number: cleanPhone }); addedCount++; }
        else existing.name = name;
      }
    }
  } else if (typeof text === 'string') {
    const lines = text.split('\n');
    for (const line of lines) {
      const clean = line.trim();
      if (!clean) continue;
      const parts = clean.split(/[,\t;]+/);
      let name = '', phone = '';
      if (parts.length >= 2) {
        if (/\d{7,}/.test(parts[0])) { phone = parts[0].replace(/\D/g, ''); name = parts.slice(1).join(' ').trim(); }
        else { name = parts[0].trim(); phone = parts[1].replace(/\D/g, ''); }
      } else {
        phone = clean.replace(/\D/g, '');
        name  = clean.replace(/\d/g, '').trim() || phone;
      }
      if (phone.length >= 8) {
        if (phone.length === 8) phone = '506' + phone;
        const id = phone + '@s.whatsapp.net';
        const existing = savedContacts.find(x => x.id === id);
        if (!existing) { savedContacts.push({ id, name: name || phone, number: phone }); addedCount++; }
        else if (name && name !== phone) existing.name = name;
      }
    }
  }
  saveContacts();
  res.json({ success: true, message: `Sincronizados ${addedCount} nuevos contactos.`, total: savedContacts.length });
});

// -------------------------------------------------------
// Invitations (public)
// -------------------------------------------------------
app.get('/api/invitation/:id', (req, res) => {
  if (fs.existsSync(invitationsFile)) {
    try { invitations = JSON.parse(fs.readFileSync(invitationsFile, 'utf8')); } catch(e) {}
  }
  const inv = invitations.find(i => i.id === req.params.id);
  if (inv) res.json({ success: true, invitation: inv });
  else     res.status(404).json({ success: false, message: 'Invitación no encontrada' });
});

// RSVP submit (public)
app.post('/api/invitation/:id/rsvp', (req, res) => {
  if (fs.existsSync(invitationsFile)) {
    try { invitations = JSON.parse(fs.readFileSync(invitationsFile, 'utf8')); } catch(e) {}
  }
  const inv = invitations.find(i => i.id === req.params.id);
  if (!inv) return res.status(404).json({ success: false, message: 'Invitación no encontrada' });

  const { attending, confirmedPasses, hasDietaryRestriction, dietaryDetails, guestNote } = req.body;
  const isAttending = attending === true || attending === 'true' || attending === 'yes';
  const maxPasses   = parseInt(inv.passes) || 1;
  let validPasses   = 0;

  if (isAttending) {
    const reqPasses = parseInt(confirmedPasses) || 1;
    validPasses = Math.min(Math.max(reqPasses, 1), maxPasses);
  }

  const hasDiet  = hasDietaryRestriction === true || hasDietaryRestriction === 'true' || hasDietaryRestriction === 'yes';
  const dietText = hasDiet ? ((dietaryDetails || '').toString().trim()) : '';

  inv.rsvp = {
    attending:             isAttending,
    status:                isAttending ? 'confirmed' : 'declined',
    confirmedPasses:       validPasses,
    maxPasses:             maxPasses,
    hasDietaryRestriction: hasDiet,
    dietaryDetails:        dietText,
    guestNote:             (guestNote || '').toString().trim(),
    submittedAt:           new Date().toISOString()
  };
  saveInvitations();

  res.json({
    success: true,
    message: isAttending
      ? `¡Perfecto! Confirmamos ${validPasses} espacio${validPasses > 1 ? 's' : ''} para ti. 🐰`
      : '¡Gracias por avisarnos! Te vamos a extrañar mucho. 💕',
    invitation: inv
  });
});

// RSVP summary (admin)
app.get('/api/admin/rsvp-summary', authenticate, (req, res) => {
  if (fs.existsSync(invitationsFile)) {
    try { invitations = JSON.parse(fs.readFileSync(invitationsFile, 'utf8')); } catch(e) {}
  }

  let totalPassesAssigned = 0, confirmedCount = 0, confirmedPasses = 0,
      declinedCount = 0, pendingCount = 0, withDietaryCount = 0;

  const list = invitations.map(inv => {
    const passes = parseInt(inv.passes) || 1;
    totalPassesAssigned += passes;
    let status = 'pending', confPasses = 0, hasDiet = false, dietDetails = '', submittedAt = null;

    if (inv.rsvp) {
      if (inv.rsvp.attending) {
        status = 'confirmed'; confirmedCount++;
        confPasses = inv.rsvp.confirmedPasses || passes;
        confirmedPasses += confPasses;
      } else {
        status = 'declined'; declinedCount++;
      }
      if (inv.rsvp.hasDietaryRestriction && inv.rsvp.dietaryDetails) {
        hasDiet = true; dietDetails = inv.rsvp.dietaryDetails; withDietaryCount++;
      }
      submittedAt = inv.rsvp.submittedAt;
    } else {
      pendingCount++;
    }

    return {
      id: inv.id, phone: inv.phone, name: inv.name, passes,
      status, confirmedPasses: confPasses, hasDietaryRestriction: hasDiet,
      dietaryDetails: dietDetails, guestNote: inv.rsvp?.guestNote || '',
      submittedAt, createdAt: inv.createdAt
    };
  });

  res.json({
    success: true,
    stats: {
      totalInvitations: invitations.length, totalPassesAssigned,
      confirmedCount, confirmedPasses, declinedCount, pendingCount, withDietaryCount
    },
    invitations: list
  });
});

// History
app.get('/api/admin/history', authenticate, (req, res) => {
  res.json({ success: true, history: sendHistory });
});

// -------------------------------------------------------
// Send WhatsApp (anti-ban)
// -------------------------------------------------------
app.post('/api/whatsapp/send', authenticate, async (req, res) => {
  if (!clientReady) return res.status(400).json({ success: false, message: 'WhatsApp no conectado' });
  const { targets, message } = req.body;
  if (!message || !targets || targets.length === 0)
    return res.status(400).json({ success: false, message: 'Faltan datos' });

  res.json({ success: true, message: `Envío iniciado a ${targets.length} invitados con anti-ban activo.` });

  (async () => {
    const BATCH_SIZE = 5;
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      try {
        const count    = target.count || '1';
        const pasesText = count === '1' ? '1 espacio' : `${count} espacios`;
        let finalMessage = message.replace(/{pases}/g, pasesText);

        const guestName = (target.customName && target.customName.trim())
          ? target.customName.trim()
          : (target.display || target.id.split('@')[0]);

        let existingInv = invitations.find(inv => inv.phone === target.id);
        let invId = existingInv ? existingInv.id : crypto.randomBytes(8).toString('hex');

        if (!existingInv) {
          existingInv = { id: invId, phone: target.id, name: guestName, passes: count, createdAt: new Date().toISOString() };
          invitations.push(existingInv);
        } else {
          existingInv.passes = count;
          existingInv.name   = guestName;
        }
        saveInvitations();

        const personalLink = `https://testdeinvitacion.ddns.net/?id=${invId}`;
        finalMessage = finalMessage.replace(/{link}/g, personalLink);

        await clientSocket.sendMessage(target.id, { text: finalMessage });

        sendHistory.push({ name: guestName, date: new Date().toISOString(), status: 'success', passes: count });
        saveHistory();

        if (i < targets.length - 1) {
          if ((i + 1) % BATCH_SIZE === 0) {
            const batchDelay = Math.floor(Math.random() * 5000) + 12000;
            console.log(`[Anti-Ban] Lote ${i + 1}/${targets.length}. Pausa: ${Math.round(batchDelay/1000)}s`);
            await new Promise(r => setTimeout(r, batchDelay));
          } else {
            await new Promise(r => setTimeout(r, Math.floor(Math.random() * 3000) + 4000));
          }
        }
      } catch (error) {
        console.error(`Error enviando a ${target.id}:`, error);
        sendHistory.push({ name: target.display || target.id, date: new Date().toISOString(), status: 'error', error: error.message });
        saveHistory();
      }
    }
  })();
});

app.listen(port, '127.0.0.1', () => console.log(`Baby Shower Amelia - Admin en http://127.0.0.1:${port}/admin`));

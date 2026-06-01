const TelegramBot = require('node-telegram-bot-api');
const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const nodemailer = require('nodemailer');
const imaps = require('imap-simple');
const config = require('./config.js');

const bot = new TelegramBot(config.BOT_TOKEN, { polling: true });
const userState = {};

// ===== MENU UTAMA DENGAN TOMBOL NEMPEL =====
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;

  const keyboard = {
    keyboard: [
      [
        { text: "📱 Conect Whatsapp" },
        { text: "📈 Access List" }
      ],
      [
        { text: "🔴 Fix Merah" },
        { text: "🔍 WA Checker" }
      ],
      [
        { text: "📢 Gabung Chanel" },
        { text: "💰 Beli Bot" }
      ]
    ],
    resize_keyboard: true,
    one_time_keyboard: false,
    persistent: true
  };

  bot.sendMessage(chatId, `Halo! Selamat datang di *${config.BOT_NAME}*\nEmail tujuan: *${config.EMAIL_TARGET}*`, {
    parse_mode: "Markdown",
    reply_markup: keyboard
  });
});

// ===== HANDLE PESAN & TOMBOL =====
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!text) return;

  // Handler tombol menu
  if (text === "📱 Conect Whatsapp") {
    bot.sendMessage(chatId, "Kirim nomor WhatsApp yang mau dipairing.\nFormat: 62812xxxxxxx");
    userState[chatId] = { step: 'waiting_wa_number' };
    return;
  }

  if (text === "🔴 Fix Merah") {
    bot.sendMessage(chatId, "Kirim nomor WhatsApp yang mau di-fix.\nContoh: 628123456789\nNomor ini akan otomatis masuk ke email.");
    userState[chatId] = { step: 'waiting_phone_for_email' };
    return;
  }

  if (text === "🔍 WA Checker") {
    bot.sendMessage(chatId, "Kirim nomor WhatsApp yang mau dicek.\nBisa kirim banyak, pisahkan dengan koma.\nContoh: 62812xxx,62813xxx");
    userState[chatId] = { step: 'waiting_checker_number' };
    return;
  }

  if (text === "📈 Access List") {
    bot.sendMessage(chatId, "Fitur Access List dipanggil");
    return;
  }

  if (text === "📢 Gabung Chanel") {
    bot.sendMessage(chatId, "Klik tombol di bawah buat join channel:", {
      reply_markup: {
        inline_keyboard: [[{ text: "Gabung Channel", url: config.CHANNEL_LINK }]]
      }
    });
    return;
  }

  if (text === "💰 Beli Bot") {
    bot.sendMessage(chatId, "Hubungi admin buat beli bot:", {
      reply_markup: {
        inline_keyboard: [[{ text: "WA 6285624886626", url: config.SUPPORT_GROUP }]]
      }
    });
    return;
  }

  // Skip kalau bukan proses state
  if (!userState[chatId] || text.startsWith('/')) return;
  const state = userState[chatId];

  // 1. Conect WhatsApp - VERSI PAIRING FIX
  if (state.step === 'waiting_wa_number') {
    const number = text.replace(/[^0-9]/g, '');
    bot.sendMessage(chatId, `Tunggu 10-15 detik ya, lagi generate kode pairing untuk ${number}...`);

    try {
      const { state: authState, saveCreds } = await useMultiFileAuthState('./auth_' + number);
      const { version } = await fetchLatestBaileysVersion();

      const sock = makeWASocket({
        auth: authState,
        logger: pino({ level: 'silent' }),
        browser: ['Windows', 'Chrome', '131.0.0'], // <-- GANTI INI
        version: version,
        printQRInTerminal: false,
        connectTimeoutMs: 60000,
        emitOwnEvents: true
      });

      sock.ev.on('creds.update', saveCreds);

      sock.ev.on('connection.update', (update) => {
        if (update.connection === 'open') {
          bot.sendMessage(chatId, `✅ Berhasil terhubung ke WhatsApp!`);
          sock.end();
        }
        if (update.connection === 'close') {
          const reason = update.lastDisconnect?.error?.output?.statusCode;
          if (reason!== DisconnectReason.loggedOut) {
            bot.sendMessage(chatId, `❌ Koneksi terputus. Coba lagi 5 menit lagi.`);
          }
        }
      });

      // Delay biar socket stabil dulu
      await new Promise(resolve => setTimeout(resolve, 3000));

      const code = await sock.requestPairingCode(number);

      if (!code) {
        bot.sendMessage(chatId, `Gagal dapet kode. WhatsApp nolak koneksi. Coba ganti jaringan HP kamu dari WiFi ke data atau sebaliknya.`);
        sock.end();
        return;
      }

      const formattedCode = code.match(/.{1,4}/g).join("-");

      bot.sendMessage(chatId,
        `Kode pairing kamu: *${formattedCode}*\n\n` +
        `1. Buka WA > Setelan > Perangkat Tertaut\n` +
        `2. Pilih "Tautkan dengan nomor telepon"\n` +
        `3. Masukkan kode di atas\n` +
        `_Kalau loading terus, matiin data WA 10 detik lalu nyalain lagi._`,
        { parse_mode: "Markdown" }
      );

      setTimeout(() => sock.end(), 70000);

    } catch (err) {
      bot.sendMessage(chatId, `Gagal generate kode:\n\`${err.message}\``, { parse_mode: "Markdown" });
    }
    delete userState[chatId];
  }

  // 2. Kirim Email dengan nomor dinamis + auto cek balasan
  if (state.step === 'waiting_phone_for_email') {
    const number = text.replace(/[^0-9+]/g, '');

    if (!number) {
      bot.sendMessage(chatId, "Nomor salah. Kirim ulang nomornya.");
      return;
    }

    const body = config.EMAIL_TEMPLATE.body.replace("{NOMOR}", number);
    const subject = config.EMAIL_TEMPLATE.subject;

    try {
      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: config.EMAIL_USER, pass: config.EMAIL_PASS }
      });

      await transporter.sendMail({
        from: config.EMAIL_USER,
        to: config.EMAIL_TARGET,
        subject: subject,
        text: body
      });

      bot.sendMessage(chatId, `✅ Banding Berhasil terkirim. Menunggu balasan dari WhatsApp...`);
      checkWhatsAppReply(chatId);

    } catch (err) {
      bot.sendMessage(chatId, `Gagal kirim email: ${err.message}`);
    }
    delete userState[chatId];
  }

  // 3. WA Checker
  if (state.step === 'waiting_checker_number') {
    const numbers = text.split(',').map(n => n.replace(/[^0-9]/g, '') + '@s.whatsapp.net');
    bot.sendMessage(chatId, `Mengecek ${numbers.length} nomor, tunggu sebentar...`);

    try {
      const { state: authState } = await useMultiFileAuthState('./auth_checker');
      const { version } = await fetchLatestBaileysVersion();
      const sock = makeWASocket({
        auth: authState,
        logger: pino({ level: 'silent' }),
        browser: ['Windows', 'Chrome', '131.0.0'],
        version: version
      });
      await new Promise(resolve => setTimeout(resolve, 3000));

      const result = await sock.onWhatsApp(...numbers);
      let terdaftar = [];
      let tidakTerdaftar = [];

      result.forEach(res => {
        if (res.exists) terdaftar.push(res.jid.split('@')[0]);
        else tidakTerdaftar.push(res.jid.split('@')[0]);
      });

      let reply = `*Hasil Checker:*\n\n✅ Terdaftar: ${terdaftar.length}\n${terdaftar.join('\n') || '-'}\n\n❌ Tidak Terdaftar: ${tidakTerdaftar.length}\n${tidakTerdaftar.join('\n') || '-'}`;
      bot.sendMessage(chatId, reply, { parse_mode: "Markdown" });
      sock.end();
    } catch (err) {
      bot.sendMessage(chatId, `Gagal cek nomor: ${err.message}`);
    }
    delete userState[chatId];
  }
});

// Fungsi cek balasan email WhatsApp
async function checkWhatsAppReply(chatId) {
  let checkCount = 0;
  const maxCheck = 20;

  const interval = setInterval(async () => {
    checkCount++;
    console.log(`[Cek Balasan] Percobaan ke-${checkCount}`);

    if (checkCount > maxCheck) {
      clearInterval(interval);
      bot.sendMessage(chatId, "⏰ Timeout 10 menit. WhatsApp belum balas.");
      return;
    }

    try {
      const connection = await imaps.connect({
        imap: {...config.IMAP, tlsOptions: { rejectUnauthorized: false } },
        imapTimeout: 10000
      });

      await connection.openBox('INBOX');
      const messages = await connection.search(['UNSEEN', ['FROM', '@support.whatsapp.com']], { bodies: ['HEADER'] });

      if (messages.length > 0) {
        clearInterval(interval);
        bot.sendMessage(chatId, `✅ WhatsApp sudah merespon.\nSilahkan ulangi nomor anda`);
        await connection.addFlags(messages[0].attributes.uid, '\\Seen');
      }
      connection.end();
    } catch (err) {
      console.log('[Cek Balasan] Error:', err.message);
      clearInterval(interval);
    }
  }, 30000);
}

bot.on("polling_error", (err) => console.log(err));
console.log(`${config.BOT_NAME} sudah jalan...`);

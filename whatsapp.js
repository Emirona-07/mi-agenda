require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const path = require('path');

const SESSION_PATH = process.env.WHATSAPP_SESSION_PATH || path.join(__dirname, '.wwebjs_auth');

let client = null;
let status = 'disconnected'; // disconnected | qr | connecting | ready
let qrDataUrl = null;

function getPuppeteerConfig() {
  const args = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'];
  // On Railway/Linux use the system Chromium installed via nixpacks
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    return { headless: true, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH, args };
  }
  // Try to use puppeteer's bundled Chrome
  try {
    const puppeteer = require('puppeteer');
    return { headless: true, executablePath: puppeteer.executablePath(), args };
  } catch(e) {
    return { headless: true, args };
  }
}

function init() {
  client = new Client({
    authStrategy: new LocalAuth({ dataPath: SESSION_PATH }),
    puppeteer: getPuppeteerConfig()
  });

  client.on('qr', async (qr) => {
    status = 'qr';
    qrDataUrl = await qrcode.toDataURL(qr);
    console.log('📱 WhatsApp: escanea el QR en Admin → Configuración → WhatsApp');
  });

  client.on('loading_screen', () => {
    status = 'connecting';
    qrDataUrl = null;
  });

  client.on('ready', () => {
    status = 'ready';
    qrDataUrl = null;
    console.log('✅ WhatsApp conectado y listo para enviar mensajes');
  });

  client.on('auth_failure', () => {
    status = 'disconnected';
    console.log('❌ WhatsApp: fallo de autenticación, reiniciando...');
    setTimeout(init, 5000);
  });

  client.on('disconnected', () => {
    status = 'disconnected';
    console.log('⚠️  WhatsApp desconectado, reiniciando...');
    setTimeout(init, 5000);
  });

  client.initialize().catch(err => {
    console.error('WhatsApp init error:', err.message);
    setTimeout(init, 10000);
  });
}

function formatPhone(phone) {
  const digits = phone.replace(/\D/g, '');
  // If it starts with 0 (local format), add country code from env or default 598 (Uruguay)
  const countryCode = process.env.WHATSAPP_COUNTRY_CODE || '598';
  if (digits.startsWith('0')) return countryCode + digits.slice(1) + '@c.us';
  // If it already has a country code (10+ digits), use as-is
  if (digits.length >= 10) return digits + '@c.us';
  return countryCode + digits + '@c.us';
}

async function sendMessage(phone, message) {
  if (status !== 'ready') {
    console.log(`WhatsApp no está listo (estado: ${status}), mensaje no enviado a ${phone}`);
    return false;
  }
  try {
    const chatId = formatPhone(phone);
    await client.sendMessage(chatId, message);
    console.log(`✅ WhatsApp enviado a ${chatId}`);
    return true;
  } catch (err) {
    console.error(`❌ Error enviando WhatsApp a ${phone}:`, err.message);
    return false;
  }
}

module.exports = {
  init,
  sendMessage,
  getStatus: () => status,
  getQR: () => qrDataUrl,
};

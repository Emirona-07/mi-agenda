require('dotenv').config();

const GRAPH_API_VERSION = 'v21.0';

function formatPhone(phone) {
  const digits = phone.replace(/\D/g, '');
  const countryCode = process.env.WHATSAPP_COUNTRY_CODE || '598';
  if (digits.startsWith('0')) return countryCode + digits.slice(1);
  if (digits.length >= 10) return digits;
  return countryCode + digits;
}

async function sendTemplate(phone, templateName, params) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_ACCESS_TOKEN;

  if (!phoneNumberId || !token) {
    console.log('WhatsApp no configurado (faltan WHATSAPP_PHONE_NUMBER_ID o WHATSAPP_ACCESS_TOKEN)');
    return false;
  }

  const to = formatPhone(phone);
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: process.env.WHATSAPP_TEMPLATE_LANG || 'es_AR' },
      components: [{
        type: 'body',
        parameters: params.map(p => ({ type: 'text', text: String(p) }))
      }]
    }
  };

  try {
    const res = await fetch(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      }
    );
    const data = await res.json();
    if (res.ok) {
      console.log(`✅ WhatsApp enviado a ${to} (${templateName})`);
      return true;
    } else {
      console.error(`❌ Error WhatsApp a ${to}:`, JSON.stringify(data.error || data));
      return false;
    }
  } catch (err) {
    console.error(`❌ Error enviando WhatsApp a ${phone}:`, err.message);
    return false;
  }
}

function getStatus() {
  if (process.env.WHATSAPP_PHONE_NUMBER_ID && process.env.WHATSAPP_ACCESS_TOKEN) {
    return 'configured';
  }
  return 'not_configured';
}

module.exports = {
  init: () => {},
  sendTemplate,
  getStatus,
};

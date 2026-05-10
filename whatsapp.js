require('dotenv').config();

const GRAPH_API_VERSION = 'v21.0';

let cachedRegisteredPhone;

function formatPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  const countryCode = process.env.WHATSAPP_COUNTRY_CODE || '598';

  if (!digits) return '';
  if (digits.startsWith('00')) return digits.slice(2);
  if (digits.startsWith('0')) return countryCode + digits.slice(1);
  if (digits.length >= 10) return digits;
  return countryCode + digits;
}

function getExplicitBusinessPhone() {
  return (
    process.env.WHATSAPP_ADMIN_PHONE ||
    process.env.WHATSAPP_BUSINESS_PHONE ||
    process.env.WHATSAPP_REGISTERED_PHONE ||
    process.env.WHATSAPP_NOTIFY_PHONE ||
    ''
  );
}

async function getRegisteredPhone() {
  const explicitPhone = getExplicitBusinessPhone();
  if (explicitPhone) return explicitPhone;
  if (cachedRegisteredPhone) return cachedRegisteredPhone;

  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_ACCESS_TOKEN;

  if (!phoneNumberId || !token) return '';

  try {
    const res = await fetch(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}?fields=display_phone_number`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );
    const data = await res.json();

    if (!res.ok) {
      console.error('No se pudo obtener el número registrado de WhatsApp:', JSON.stringify(data.error || data));
      return '';
    }

    cachedRegisteredPhone = data.display_phone_number || '';
    return cachedRegisteredPhone;
  } catch (err) {
    console.error('Error consultando el número registrado de WhatsApp:', err.message);
    return '';
  }
}

function buildTemplatePayload(to, templateName, params) {
  return {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: process.env.WHATSAPP_TEMPLATE_LANG || 'es_AR' },
      components: [{
        type: 'body',
        parameters: (params || []).map(p => ({ type: 'text', text: String(p) }))
      }]
    }
  };
}

async function sendTemplateToPhone(phone, templateName, params) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_ACCESS_TOKEN;

  if (!phoneNumberId || !token) {
    console.log('WhatsApp no configurado (faltan WHATSAPP_PHONE_NUMBER_ID o WHATSAPP_ACCESS_TOKEN)');
    return false;
  }

  const to = formatPhone(phone);
  if (!to) {
    console.error('No se pudo enviar WhatsApp: número vacío o inválido');
    return false;
  }

  try {
    const res = await fetch(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(buildTemplatePayload(to, templateName, params))
      }
    );
    const data = await res.json();

    if (res.ok) {
      console.log(`WhatsApp enviado a ${to} (${templateName})`);
      return true;
    }

    console.error(`Error WhatsApp a ${to}:`, JSON.stringify(data.error || data));
    return false;
  } catch (err) {
    console.error(`Error enviando WhatsApp a ${phone}:`, err.message);
    return false;
  }
}

async function sendTemplate(phone, templateName, params, options = {}) {
  const notifyBusiness = options.notifyBusiness !== false;
  const recipients = [{
    phone,
    templateName,
    params,
  }];

  if (notifyBusiness) {
    const registeredPhone = await getRegisteredPhone();
    if (registeredPhone) {
      recipients.push({
        phone: registeredPhone,
        templateName: options.businessTemplateName || process.env.WHATSAPP_BUSINESS_TEMPLATE_NAME || templateName,
        params: options.businessParams || params,
      });
    }
  }

  const seen = new Set();
  const uniqueRecipients = recipients.filter(recipient => {
    const formattedPhone = formatPhone(recipient.phone);
    if (!formattedPhone || seen.has(formattedPhone)) return false;
    seen.add(formattedPhone);
    recipient.phone = formattedPhone;
    return true;
  });

  const results = await Promise.all(
    uniqueRecipients.map(recipient => sendTemplateToPhone(
      recipient.phone,
      recipient.templateName,
      recipient.params
    ))
  );

  return results.length > 0 && results.every(Boolean);
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

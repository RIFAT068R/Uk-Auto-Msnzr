require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const modelName = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';

console.log('Using Gemini model:', modelName);

const REQUIRED_ENV_VARS = [
  'PAGE_ACCESS_TOKEN',
  'VERIFY_TOKEN',
  'APP_SECRET',
  'GEMINI_API_KEY',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY'
];

const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

// Keep the raw body so Meta webhook signatures can be verified safely.
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

app.get('/', (req, res) => {
  res.status(200).send('Messenger AI Bot is running');
});

app.get('/webhook', verifyWebhook);
app.post('/webhook', async (req, res) => {
  try {
    if (!isValidSignature(req)) {
      console.error('Webhook signature verification failed.');
      return res.sendStatus(403);
    }

    if (req.body.object !== 'page') {
      return res.sendStatus(404);
    }

    const entries = Array.isArray(req.body.entry) ? req.body.entry : [];

    for (const entry of entries) {
      const events = Array.isArray(entry.messaging) ? entry.messaging : [];

      for (const event of events) {
        handleIncomingMessage(event).catch((error) => {
          console.error('Failed to process messaging event:', error.message, error.response?.data || '');
        });
      }
    }

    return res.status(200).send('EVENT_RECEIVED');
  } catch (error) {
    console.error('Unexpected webhook error:', error.message, error.response?.data || '');
    return res.sendStatus(500);
  }
});

async function verifyWebhook(req, res) {
  try {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }

    return res.sendStatus(403);
  } catch (error) {
    console.error('Webhook verification failed:', error.message);
    return res.sendStatus(500);
  }
}

async function handleIncomingMessage(event) {
  if (!event || !event.sender || !event.sender.id) {
    return;
  }

  // Ignore non-message events that should not trigger AI replies.
  if (event.delivery || event.read || event.optin || event.postback || event.reaction || event.presence) {
    return;
  }

  const senderPsid = event.sender.id;
  const recipientPsid = event.recipient?.id;
  const messageText = event.message?.text?.trim();

  // Ignore attachments-only messages and page echo events.
  if (!messageText || event.message?.is_echo) {
    return;
  }

  if (recipientPsid && senderPsid === recipientPsid) {
    return;
  }

  const customer = await getOrCreateCustomer(senderPsid);
  await saveMessage(senderPsid, 'user', messageText);

  if (customer.human_handoff) {
    const handoffReply = 'Our team will check and reply shortly.';
    await saveMessage(senderPsid, 'assistant', handoffReply);
    await sendTyping(senderPsid);
    await sendMessengerMessage(senderPsid, handoffReply);
    return;
  }

  const recentMessages = await getRecentMessages(senderPsid);
  const productData = await getProductContext(messageText, customer);

  const aiResult = await generateAIReply({
    senderPsid,
    messageText,
    customer,
    recentMessages,
    productData
  });

  const replyText = aiResult.memory?.human_handoff
    ? 'Our team will check and reply shortly.'
    : aiResult.reply || 'Thanks for your message. Please share the product name or screenshot, and we will help you shortly.';

  await saveMessage(senderPsid, 'assistant', replyText, aiResult);

  const updatedCustomer = await updateCustomerMemory(senderPsid, customer, aiResult, messageText);
  await createOrderIfComplete(updatedCustomer);

  await sendTyping(senderPsid);
  await sendMessengerMessage(senderPsid, updatedCustomer.human_handoff ? 'Our team will check and reply shortly.' : replyText);
}

async function getOrCreateCustomer(psid) {
  try {
    const { data, error } = await supabase
      .from('customers')
      .select('*')
      .eq('psid', psid)
      .maybeSingle();

    if (error) {
      throw error;
    }

    if (data) {
      return data;
    }

    const newCustomer = {
      psid,
      full_name: null,
      phone: null,
      address: null,
      last_product: null,
      last_intent: 'new_customer',
      conversation_summary: 'New Messenger customer',
      order_status: 'not_started',
      human_handoff: false
    };

    const { data: inserted, error: insertError } = await supabase
      .from('customers')
      .insert(newCustomer)
      .select('*')
      .single();

    if (insertError) {
      throw insertError;
    }

    await updateCustomerInSheet(inserted);

    return inserted;
  } catch (error) {
    console.error('getOrCreateCustomer failed:', error.message, error.details || '');
    return {
      psid,
      full_name: null,
      phone: null,
      address: null,
      last_product: null,
      last_intent: 'fallback',
      conversation_summary: 'Temporary customer context unavailable',
      order_status: 'not_started',
      human_handoff: false
    };
  }
}

async function saveMessage(psid, role, messageText, metadata = null) {
  try {
    const payload = {
      psid,
      role,
      message_text: messageText,
      metadata
    };

    const { error } = await supabase.from('messages').insert(payload);

    if (error) {
      throw error;
    }
  } catch (error) {
    console.error('saveMessage failed:', error.message, error.details || '');
  }
}

async function getRecentMessages(psid, limit = 12) {
  try {
    const { data, error } = await supabase
      .from('messages')
      .select('role, message_text, created_at')
      .eq('psid', psid)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      throw error;
    }

    return (data || []).reverse();
  } catch (error) {
    console.error('getRecentMessages failed:', error.message, error.details || '');
    return [];
  }
}

async function generateAIReply({ senderPsid, messageText, customer, recentMessages, productData }) {
  const sensitiveMessage = containsSensitiveInfo(messageText);

  if (sensitiveMessage) {
    return {
      reply: 'Please do not share OTP, password, card number, or PIN here. For your safety, keep this information private.',
      memory: {
        last_intent: 'shared_sensitive_info',
        conversation_summary: 'Customer attempted to share sensitive information',
        human_handoff: false
      }
    };
  }

  const systemInstruction = [
    'You are a friendly professional e-commerce Messenger support assistant for UK Brand Lover.',
    'Reply like a real human support agent.',
    'Keep replies short, warm, and helpful.',
    'If the customer uses Bangla-English or Banglish, reply in similar style.',
    'Never invent price, stock, delivery charge, ETA, or fake offers.',
    'If product is unclear, ask for product name or screenshot.',
    'Guide interested customers toward order confirmation.',
    'If customer wants to order, collect: name, phone number, full address, product name, quantity.',
    'If complaint, refund, damaged product, wrong product, or serious issue appears, apologize and set human_handoff=true.',
    'If discount is requested, respond politely without fake promises.',
    'If human_handoff=true, the reply must be exactly: Our team will check and reply shortly.',
    'Return valid JSON only with this shape: {"reply":"string","memory":{"full_name":null,"phone":null,"address":null,"last_product":null,"last_intent":null,"conversation_summary":null,"order_status":null,"human_handoff":false},"order":{"product_name":null,"quantity":null}}'
  ].join(' ');

  const model = {
    model: modelName,
    systemInstruction
  };

  const promptPayload = {
    customer_psid: senderPsid,
    current_message: messageText,
    customer_memory: {
      full_name: customer.full_name,
      phone: customer.phone,
      address: customer.address,
      last_product: customer.last_product,
      last_intent: customer.last_intent,
      conversation_summary: customer.conversation_summary,
      order_status: customer.order_status,
      human_handoff: customer.human_handoff
    },
    recent_chat_history: recentMessages,
    product_context: productData,
    assistant_rules: {
      ask_for_missing_order_fields: true,
      avoid_fake_information: true,
      keep_reply_under_3_short_sentences: true
    }
  };

  try {
    // Gemini is asked to return JSON only so memory can be updated safely.
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model.model)}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: `${model.systemInstruction}\n\nConversation data:\n${JSON.stringify(promptPayload, null, 2)}`
              }
            ]
          }
        ],
        generationConfig: {
          temperature: 0.7,
          topP: 0.9,
          maxOutputTokens: 400,
          responseMimeType: 'application/json'
        }
      },
      {
        timeout: 30000,
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );

    const rawText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    const parsed = safeJsonParse(rawText);

    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Gemini returned invalid JSON');
    }

    return {
      reply: parsed.reply,
      memory: parsed.memory || {},
      order: parsed.order || {}
    };
  } catch (error) {
    console.error('generateAIReply failed:', error.message, error.response?.data || '');
    return {
      reply: 'Thanks for messaging UK Brand Lover. Please share the product name or screenshot, and we will help you shortly.',
      memory: {
        last_intent: 'fallback_support',
        conversation_summary: 'Fallback reply sent because AI generation failed',
        human_handoff: false
      },
      order: {
        product_name: customer.last_product,
        quantity: null
      }
    };
  }
}

async function updateCustomerMemory(psid, existingCustomer, aiResult, latestMessageText) {
  const extracted = extractContactInfo(latestMessageText);
  const memory = aiResult.memory || {};
  const shouldHandoff = Boolean(memory.human_handoff) || looksLikeComplaint(latestMessageText);

  // Merge AI memory updates with rule-based extraction from the latest message.
  const updateData = {
    full_name: firstDefined(memory.full_name, extracted.full_name, existingCustomer.full_name),
    phone: firstDefined(memory.phone, extracted.phone, existingCustomer.phone),
    address: firstDefined(memory.address, extracted.address, existingCustomer.address),
    last_product: firstDefined(memory.last_product, aiResult.order?.product_name, existingCustomer.last_product),
    last_intent: firstDefined(memory.last_intent, existingCustomer.last_intent, 'general_query'),
    conversation_summary: shortenSummary(firstDefined(memory.conversation_summary, existingCustomer.conversation_summary, 'Customer chat updated')),
    order_status: firstDefined(memory.order_status, existingCustomer.order_status, 'not_started'),
    human_handoff: shouldHandoff
  };

  try {
    const { data, error } = await supabase
      .from('customers')
      .update(updateData)
      .eq('psid', psid)
      .select('*')
      .single();

    if (error) {
      throw error;
    }

    await updateCustomerInSheet(data);

    return data;
  } catch (error) {
    console.error('updateCustomerMemory failed:', error.message, error.details || '');
    return {
      ...existingCustomer,
      ...updateData
    };
  }
}

async function createOrderIfComplete(customer) {
  try {
    if (customer.human_handoff) {
      return;
    }

    // A simple rule-based pass is used for quantity so orders can still be created
    // even if the AI reply did not include a structured quantity value.
    const recentMessages = await getRecentMessages(customer.psid, 20);
    const userText = recentMessages
      .filter((message) => message.role === 'user')
      .map((message) => message.message_text)
      .join(' ');

    const quantityMatch = userText.match(/(?:qty|quantity|x)\s*[:=-]?\s*(\d{1,3})/i) || userText.match(/\b(\d{1,3})\s*(?:pcs|pieces|piece)\b/i);
    const quantity = quantityMatch ? Number(quantityMatch[1]) : null;
    const productName = customer.last_product;

    const isComplete = Boolean(customer.full_name && customer.phone && customer.address && productName && quantity);
    if (!isComplete) {
      return;
    }

    const { data: existingOrder, error: existingOrderError } = await supabase
      .from('orders')
      .select('id')
      .eq('psid', customer.psid)
      .eq('product_name', productName)
      .eq('phone', customer.phone)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existingOrderError) {
      throw existingOrderError;
    }

    if (existingOrder) {
      return;
    }

    const orderPayload = {
      psid: customer.psid,
      customer_name: customer.full_name,
      phone: customer.phone,
      address: customer.address,
      product_name: productName,
      quantity,
      order_status: customer.order_status || 'pending_confirmation'
    };

    const { error: orderError } = await supabase.from('orders').insert(orderPayload);
    if (orderError) {
      throw orderError;
    }

    await addOrderToSheet(orderPayload);

    const { error: customerError } = await supabase
      .from('customers')
      .update({ order_status: 'order_created' })
      .eq('psid', customer.psid);

    if (customerError) {
      throw customerError;
    }
  } catch (error) {
    console.error('createOrderIfComplete failed:', error.message, error.details || '');
  }
}

async function sendTyping(psid) {
  try {
    await axios.post(
      'https://graph.facebook.com/v19.0/me/messages',
      {
        recipient: { id: psid },
        sender_action: 'typing_on'
      },
      {
        params: {
          access_token: process.env.PAGE_ACCESS_TOKEN
        },
        timeout: 15000
      }
    );
  } catch (error) {
    console.error('sendTyping failed:', error.message, error.response?.data || '');
  }
}

async function sendMessengerMessage(psid, messageText) {
  try {
    await axios.post(
      'https://graph.facebook.com/v19.0/me/messages',
      {
        recipient: { id: psid },
        messaging_type: 'RESPONSE',
        message: { text: messageText }
      },
      {
        params: {
          access_token: process.env.PAGE_ACCESS_TOKEN
        },
        timeout: 15000
      }
    );
  } catch (error) {
    console.error('sendMessengerMessage failed:', error.message, error.response?.data || '');
  }
}

function isValidSignature(req) {
  try {
    const signature = req.get('x-hub-signature-256');

    if (!signature || !req.rawBody || !process.env.APP_SECRET) {
      return false;
    }

    const expectedSignature = `sha256=${crypto
      .createHmac('sha256', process.env.APP_SECRET)
      .update(req.rawBody)
      .digest('hex')}`;

    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
  } catch (error) {
    console.error('Signature verification error:', error.message);
    return false;
  }
}

function containsSensitiveInfo(text) {
  const sensitivePatterns = [
    /\botp\b/i,
    /\bpin\b/i,
    /\bpassword\b/i,
    /\bcard\s*number\b/i,
    /\bcvv\b/i,
    /\b\d{13,19}\b/
  ];

  return sensitivePatterns.some((pattern) => pattern.test(text));
}

function looksLikeComplaint(text) {
  return /(complain|complaint|refund|damaged|wrong product|bad product|issue|problem|fake|scam)/i.test(text || '');
}

function extractContactInfo(text) {
  const phoneMatch = text.match(/(?:\+?88)?01[3-9]\d{8}/);
  const nameMatch = text.match(/(?:my name is|name is|ami|i am)\s+([a-z ,.'-]{3,50})/i);
  const addressMatch = text.match(/(?:address|thikana|location)\s*[:=-]?\s*(.{10,160})/i);

  return {
    phone: phoneMatch ? phoneMatch[0] : null,
    full_name: nameMatch ? normalizeName(nameMatch[1]) : null,
    address: addressMatch ? addressMatch[1].trim() : null
  };
}

function normalizeName(value) {
  return value
    .replace(/[^a-z ,.'-]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }

  return null;
}

function shortenSummary(summary) {
  return String(summary || '').slice(0, 280) || 'Customer chat updated';
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch (error) {
    return null;
  }
}

async function getProductContext(messageText, customer) {
  try {
    const products = await getProductsFromSheet();
    if (!products.length) {
      return {
        source: 'none',
        note: 'Google Sheets product source is not configured or returned no rows.'
      };
    }
    const query = `${messageText} ${customer.last_product || ''}`.toLowerCase();

    const matches = products
      .filter((product) => JSON.stringify(product).toLowerCase().includes(query.trim()))
      .slice(0, 3);

    return {
      source: 'google_sheets',
      matches,
      note: matches.length ? 'Potential product matches found.' : 'No matching product found in sheet.'
    };
  } catch (error) {
    console.error('getProductContext failed:', error.message);
    return {
      source: 'google_sheets',
      note: 'Product lookup failed.'
    };
  }
}

async function getProductsFromSheet() {
  try {
    const response = await callAppsScriptApi('getProductsFromSheet');
    const products = Array.isArray(response.products)
      ? response.products
      : Array.isArray(response.data)
        ? response.data
        : Array.isArray(response.rows)
          ? response.rows
          : [];

    return products.map((product) => normalizeSheetRow(product));
  } catch (error) {
    console.error('getProductsFromSheet failed:', error.message, error.response?.data || '');
    return [];
  }
}

async function addOrderToSheet(order) {
  try {
    await callAppsScriptApi('addOrderToSheet', { order });
  } catch (error) {
    console.error('addOrderToSheet failed:', error.message, error.response?.data || '');
  }
}

async function updateCustomerInSheet(customer) {
  try {
    await callAppsScriptApi('updateCustomerInSheet', { customer });
  } catch (error) {
    console.error('updateCustomerInSheet failed:', error.message, error.response?.data || '');
  }
}

async function callAppsScriptApi(action, payload = {}) {
  if (!process.env.GOOGLE_APPS_SCRIPT_URL || !process.env.GOOGLE_APPS_SCRIPT_SECRET) {
    throw new Error('Google Apps Script configuration is missing');
  }

  const response = await axios.post(
    process.env.GOOGLE_APPS_SCRIPT_URL,
    {
      action,
      secret: process.env.GOOGLE_APPS_SCRIPT_SECRET,
      sheetId: process.env.GOOGLE_SHEET_ID || null,
      ...payload
    },
    {
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 30000
    }
  );

  return response.data || {};
}

function normalizeSheetRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      String(key).trim().toLowerCase().replace(/\s+/g, '_'),
      value
    ])
  );
}

function logMissingEnv() {
  const missing = REQUIRED_ENV_VARS.filter((name) => !process.env[name]);

  if (missing.length) {
    console.warn(`Missing environment variables: ${missing.join(', ')}`);
  }
}

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
});

logMissingEnv();

app.listen(PORT, () => {
  console.log(`Messenger AI Bot listening on port ${PORT}`);
});

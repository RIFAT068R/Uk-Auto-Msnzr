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

  const incomingLanguageStyle = detectLanguageStyle(messageText);
  const replyControl = analyzeFollowUpReplyIntent(messageText, customer, incomingLanguageStyle);

  if (customer.human_handoff) {
    const handoffReply = 'Our team will check and reply shortly.';
    await saveMessage(senderPsid, 'assistant', handoffReply);
    await sendTyping(senderPsid);
    await sendMessengerMessage(senderPsid, handoffReply);
    return;
  }

  if (replyControl.immediateReply) {
    await updateCustomerMemory(senderPsid, customer, { memory: {}, order: {} }, messageText, {
      languageStyle: incomingLanguageStyle,
      stopFollowups: true,
      forcedLastIntent: replyControl.lastIntent,
      productData: { matchedProduct: null }
    });
    await saveMessage(senderPsid, 'assistant', replyControl.immediateReply, {
      type: 'followup_stop_reply',
      reason: replyControl.lastIntent
    });
    await sendTyping(senderPsid);
    await sendMessengerMessage(senderPsid, replyControl.immediateReply);
    return;
  }

  const recentMessages = await getRecentMessages(senderPsid);
  const productData = await getProductContext(messageText, customer);

  console.log('matchedProduct:', productData.matchedProduct?.display_name || null);
  console.log('intent:', productData.intent);
  console.log('products count:', productData.matches?.length || 0);

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

  console.log('final AI reply:', replyText);

  await saveMessage(senderPsid, 'assistant', replyText, aiResult);

  const updatedCustomer = await updateCustomerMemory(senderPsid, customer, aiResult, messageText, {
    languageStyle: incomingLanguageStyle,
    stopFollowups: replyControl.stopFollowups,
    forcedLastIntent: replyControl.lastIntent,
    productData,
    priceFollowupState: buildPriceFollowupState(productData, aiResult, incomingLanguageStyle)
  });
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
      last_product_notes: null,
      last_intent: 'new_customer',
      conversation_summary: 'New Messenger customer',
      order_status: 'not_started',
      human_handoff: false,
      price_given_at: null,
      last_customer_message_at: null,
      last_language_style: null,
      followup_1_sent: false,
      followup_1_sent_at: null,
      followup_2_sent: false,
      followup_2_sent_at: null,
      followup_3_sent: false,
      followup_3_sent_at: null,
      last_followup_angle: null
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
      last_product_notes: null,
      last_intent: 'fallback',
      conversation_summary: 'Temporary customer context unavailable',
      order_status: 'not_started',
      human_handoff: false,
      price_given_at: null,
      last_customer_message_at: null,
      last_language_style: null,
      followup_1_sent: false,
      followup_1_sent_at: null,
      followup_2_sent: false,
      followup_2_sent_at: null,
      followup_3_sent: false,
      followup_3_sent_at: null,
      last_followup_angle: null
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
  const languageStyle = detectLanguageStyle(messageText);

  if (sensitiveMessage) {
    return {
      reply: getSensitiveInfoReply(languageStyle),
      memory: {
        last_intent: 'shared_sensitive_info',
        conversation_summary: 'Customer attempted to share sensitive information',
        human_handoff: false
      }
    };
  }

  const directSalesReply = buildDirectSalesReply(messageText, customer, productData);
  if (directSalesReply) {
    return directSalesReply;
  }

  const systemInstruction = [
    'You are a premium human-like e-commerce sales assistant for UK Brand Lover.',
    'UK Brand Lover sells 100% original UK products with proof. This is a major trust point and should be used naturally in sales replies.',
    'Your job is not just to answer; your job is to help the customer feel confident and guide them toward ordering.',
    'Tone: Friendly, confident, premium, natural, short, human, sales-focused.',
    'First detect the customer language style as one of: english, bangla, banglish, mixed.',
    'Always reply in the same language style the customer uses.',
    'If customer writes in Bangla, reply in Bangla.',
    'If customer writes in English, reply in English.',
    'If customer writes in Banglish, reply in Banglish.',
    'If customer mixes Bangla and English, reply naturally in mixed Bangla-English.',
    'If customer asks for price and product is known, give the price immediately.',
    'Do not ask for quantity before giving price.',
    'Do not ask for screenshot if product is already clear.',
    'If product is matched, include price, stock, delivery charge, authenticity proof, and a soft buying CTA.',
    'Use the line 100% original UK product with proof naturally when relevant.',
    'If product is unclear, ask only one short clarification question.',
    'If customer seems interested, guide them gently toward order confirmation.',
    'If customer asks which one do you have, list matching available products.',
    'If customer asks available, answer stock clearly.',
    'Treat these as price intent: price, dam, দাম, koto, কত, price koto, দাম কত, কত টাকা.',
    'Treat these as order intent: order, confirm, nibo, নিবো, লাগবে, নিতে চাই, book koren, reserve.',
    'Treat these as availability intent: available, ache, আছে, stock, ase, আছে নাকি.',
    'If customer says confirm, order, nibo, or lagbe, collect name, phone, address, product, and quantity.',
    'Never invent price, stock, offer, delivery date, or discount.',
    'If information is missing from product data, say the team will confirm.',
    'Do not write long paragraphs.',
    'Do not sound robotic.',
    'Do not use too many emojis.',
    'Keep product names in English exactly as stored in product data.',
    'Keep prices and delivery charges clear with the ৳ symbol.',
    'Best reply format when product is known: Yes, [Product Name] is available ✅ Price: ৳[Price] Delivery: Dhaka ৳[Inside], outside Dhaka ৳[Outside] It\'s 100% original UK product with proof. Would you like me to reserve 1 piece for you?',
    'If complaint, refund, damaged product, wrong product, or serious issue appears, apologize and set human_handoff=true.',
    'If discount is requested, respond politely without fake promises.',
    'Use light emojis only when natural: ✅ 😊',
    'If human_handoff=true, the reply must be exactly: Our team will check and reply shortly.',
    'Return valid JSON only with this shape: {"reply":"string","memory":{"full_name":null,"phone":null,"address":null,"last_product":null,"last_intent":null,"conversation_summary":null,"order_status":null,"human_handoff":false},"order":{"product_name":null,"quantity":null}}'
  ].join(' ');

  const model = {
    model: modelName,
    systemInstruction
  };

  const promptPayload = {
    customer_psid: senderPsid,
    detected_language_style: languageStyle,
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
      reply: getFallbackReply(languageStyle),
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

async function updateCustomerMemory(psid, existingCustomer, aiResult, latestMessageText, context = {}) {
  const extracted = extractContactInfo(latestMessageText);
  const memory = aiResult.memory || {};
  const shouldHandoff = Boolean(memory.human_handoff) || looksLikeComplaint(latestMessageText);
  const matchedProduct = context.productData?.matchedProduct || null;
  const priceFollowupState = context.priceFollowupState || null;
  const nowIso = new Date().toISOString();

  // Merge AI memory updates with rule-based extraction from the latest message.
  const updateData = {
    full_name: firstDefined(memory.full_name, extracted.full_name, existingCustomer.full_name),
    phone: firstDefined(memory.phone, extracted.phone, existingCustomer.phone),
    address: firstDefined(memory.address, extracted.address, existingCustomer.address),
    last_product: firstDefined(memory.last_product, aiResult.order?.product_name, existingCustomer.last_product),
    last_product_notes: firstDefined(getField(matchedProduct || {}, 'notes', 'note', 'description'), existingCustomer.last_product_notes),
    last_intent: firstDefined(context.forcedLastIntent, memory.last_intent, existingCustomer.last_intent, 'general_query'),
    conversation_summary: shortenSummary(firstDefined(memory.conversation_summary, existingCustomer.conversation_summary, 'Customer chat updated')),
    order_status: firstDefined(memory.order_status, existingCustomer.order_status, 'not_started'),
    human_handoff: shouldHandoff,
    last_customer_message_at: nowIso,
    last_language_style: firstDefined(context.languageStyle, existingCustomer.last_language_style),
    price_given_at: existingCustomer.price_given_at,
    followup_1_sent: existingCustomer.followup_1_sent,
    followup_1_sent_at: existingCustomer.followup_1_sent_at,
    followup_2_sent: existingCustomer.followup_2_sent,
    followup_2_sent_at: existingCustomer.followup_2_sent_at,
    followup_3_sent: existingCustomer.followup_3_sent,
    followup_3_sent_at: existingCustomer.followup_3_sent_at,
    last_followup_angle: existingCustomer.last_followup_angle
  };

  if (context.stopFollowups) {
    updateData.last_followup_angle = firstDefined(existingCustomer.last_followup_angle, 'stopped');
  }

  if (priceFollowupState?.priceGiven) {
    updateData.last_intent = 'price_given';
    updateData.price_given_at = nowIso;
    updateData.last_product = firstDefined(priceFollowupState.productName, updateData.last_product, existingCustomer.last_product);
    updateData.last_product_notes = firstDefined(priceFollowupState.productNotes, updateData.last_product_notes, existingCustomer.last_product_notes);
    updateData.last_language_style = firstDefined(priceFollowupState.languageStyle, updateData.last_language_style, existingCustomer.last_language_style);
    updateData.followup_1_sent = false;
    updateData.followup_1_sent_at = null;
    updateData.followup_2_sent = false;
    updateData.followup_2_sent_at = null;
    updateData.followup_3_sent = false;
    updateData.followup_3_sent_at = null;
    updateData.last_followup_angle = null;
  }

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
        intent: detectIntent(messageText),
        matches: [],
        matchedProduct: null,
        note: 'Google Sheets product source is not configured or returned no rows.'
      };
    }

    const intent = detectIntent(messageText);
    let matches = rankProductMatches(products, messageText, customer.last_product).slice(0, 5);

    if (!matches.length && intent === 'list_products') {
      matches = products.slice(0, 5);
    }

    const matchedProduct = matches[0] || null;

    return {
      source: 'google_sheets',
      intent,
      matches,
      matchedProduct,
      note: matches.length ? 'Potential product matches found.' : 'No matching product found in sheet.'
    };
  } catch (error) {
    console.error('getProductContext failed:', error.message);
    return {
      source: 'google_sheets',
      intent: detectIntent(messageText),
      matches: [],
      matchedProduct: null,
      note: 'Product lookup failed.'
    };
  }
}

function buildDirectSalesReply(messageText, customer, productData) {
  const intent = productData.intent;
  const matchedProduct = productData.matchedProduct;
  const languageStyle = detectLanguageStyle(messageText);

  if (looksLikeComplaint(messageText)) {
    return null;
  }

  if (intent === 'list_products' && productData.matches?.length) {
    const reply = formatProductListReply(productData.matches, languageStyle);

    return {
      reply,
      memory: {
        last_product: productData.matches[0].display_name,
        last_intent: intent,
        conversation_summary: `Customer asked available products, shared ${productData.matches.length} options`,
        human_handoff: false
      },
      order: {
        product_name: productData.matches[0].display_name,
        quantity: null
      }
    };
  }

  if (!matchedProduct && intent === 'price_query' && customer.last_product) {
    return {
      reply: getKnownProductPriceFallback(customer.last_product, languageStyle),
      memory: {
        last_product: customer.last_product,
        last_intent: intent,
        conversation_summary: `Customer asked price for remembered product ${customer.last_product}`,
        human_handoff: false
      },
      order: {
        product_name: customer.last_product,
        quantity: null
      }
    };
  }

  if (!matchedProduct) {
    if (intent === 'size_query') {
      return {
        reply: getSizeClarificationReply(languageStyle),
        memory: {
          last_intent: intent,
          conversation_summary: 'Asked one short clarification question for product size',
          human_handoff: false
        },
        order: {
          product_name: customer.last_product,
          quantity: null
        }
      };
    }

    return null;
  }

  if (intent === 'order_intent') {
    return {
      reply: getOrderCollectionReply(languageStyle),
      memory: {
        last_product: matchedProduct.display_name,
        last_intent: intent,
        conversation_summary: `Started order collection for ${matchedProduct.display_name}`,
        human_handoff: false,
        order_status: 'collecting_details'
      },
      order: {
        product_name: matchedProduct.display_name,
        quantity: null
      }
    };
  }

  if (intent === 'price_query' || intent === 'size_query' || intent === 'product_query' || intent === 'availability_query' || intent === 'delivery_query' || intent === 'total_query' || intent === 'proof_query') {
    return {
      reply: formatProductSalesReply(matchedProduct, languageStyle, intent, messageText, customer),
      memory: {
        last_product: matchedProduct.display_name,
        last_intent: intent,
        conversation_summary: `Discussed ${matchedProduct.display_name} with direct sales reply`,
        human_handoff: false
      },
      order: {
        product_name: matchedProduct.display_name,
        quantity: null
      }
    };
  }

  return null;
}

function analyzeFollowUpReplyIntent(messageText, customer, languageStyle) {
  const activePriceThread = customer.last_intent === 'price_given' && Boolean(customer.price_given_at);

  if (!activePriceThread) {
    return {
      stopFollowups: false,
      immediateReply: null,
      lastIntent: null
    };
  }

  if (isNotInterestedMessage(messageText)) {
    return {
      stopFollowups: true,
      immediateReply: getNotInterestedReply(languageStyle),
      lastIntent: 'not_interested'
    };
  }

  if (isLaterMessage(messageText)) {
    return {
      stopFollowups: true,
      immediateReply: getLaterReply(languageStyle),
      lastIntent: 'followup_paused'
    };
  }

  return {
    stopFollowups: true,
    immediateReply: null,
    lastIntent: 'customer_replied_after_price'
  };
}

function buildPriceFollowupState(productData, aiResult, languageStyle) {
  const matchedProduct = productData?.matchedProduct || null;
  const productName = matchedProduct?.display_name || aiResult.order?.product_name || null;
  const productPrice = getField(matchedProduct || {}, 'price', 'regular_price', 'sale_price');
  const priceGiven = Boolean(productName && productPrice && (productData?.intent === 'price_query' || /৳|price\s*:/i.test(aiResult.reply || '')));

  return {
    priceGiven,
    productName,
    productNotes: getField(matchedProduct || {}, 'notes', 'note', 'description'),
    languageStyle
  };
}

let isProcessingFollowUps = false;

async function processPendingFollowUps() {
  if (isProcessingFollowUps) {
    return;
  }

  isProcessingFollowUps = true;

  try {
    const { data, error } = await supabase
      .from('customers')
      .select('*')
      .not('price_given_at', 'is', null);

    if (error) {
      throw error;
    }

    const customers = data || [];
    const products = await getProductsFromSheet();

    for (const customer of customers) {
      await processCustomerFollowUp(customer, products);
    }
  } catch (error) {
    console.error('processPendingFollowUps failed:', error.message, error.details || '');
  } finally {
    isProcessingFollowUps = false;
  }
}

async function processCustomerFollowUp(customer, products) {
  const evaluation = evaluateFollowUpStage(customer);

  if (!evaluation.stage) {
    console.log('follow-up stage:', 'skip');
    console.log('follow-up angle:', customer.last_followup_angle || null);
    console.log('selected language:', customer.last_language_style || null);
    console.log('selected product:', customer.last_product || null);
    console.log('skipped reason:', evaluation.reason);
    return;
  }

  const product = selectFollowUpProduct(customer, products);
  const languageStyle = customer.last_language_style || 'english';
  const replyText = buildFollowUpMessage(evaluation.stage, languageStyle, customer, product);

  if (!replyText) {
    console.log('follow-up stage:', evaluation.stage);
    console.log('follow-up angle:', evaluation.angle);
    console.log('selected language:', languageStyle);
    console.log('selected product:', customer.last_product || null);
    console.log('skipped reason:', 'No follow-up message generated');
    return;
  }

  console.log('follow-up stage:', evaluation.stage);
  console.log('follow-up angle:', evaluation.angle);
  console.log('selected language:', languageStyle);
  console.log('selected product:', product?.display_name || customer.last_product || null);

  try {
    await sendTyping(customer.psid);
    await sendMessengerMessage(customer.psid, replyText);
    await saveMessage(customer.psid, 'assistant', replyText, {
      type: 'followup',
      stage: evaluation.stage,
      angle: evaluation.angle
    });
    await markFollowUpSent(customer.psid, evaluation.stage, evaluation.angle);
    console.log('sent success/failure:', 'success');
  } catch (error) {
    console.error('follow-up send failed:', error.message, error.response?.data || '');
    console.log('sent success/failure:', 'failure');
  }
}

function evaluateFollowUpStage(customer) {
  const now = Date.now();
  const priceGivenAt = customer.price_given_at ? new Date(customer.price_given_at).getTime() : null;
  const lastCustomerMessageAt = customer.last_customer_message_at ? new Date(customer.last_customer_message_at).getTime() : null;

  if (!priceGivenAt) {
    return { stage: null, reason: 'price_given_at missing' };
  }

  if (customer.last_intent !== 'price_given') {
    return { stage: null, reason: `last_intent=${customer.last_intent}` };
  }

  if (customer.human_handoff) {
    return { stage: null, reason: 'human_handoff enabled' };
  }

  if (['confirmed', 'order_created'].includes(customer.order_status)) {
    return { stage: null, reason: `order_status=${customer.order_status}` };
  }

  if (!lastCustomerMessageAt || now - lastCustomerMessageAt > 24 * 60 * 60 * 1000) {
    return { stage: null, reason: 'outside Meta 24-hour window' };
  }

  const elapsed = now - priceGivenAt;

  if (!customer.followup_3_sent && elapsed >= 20 * 60 * 60 * 1000) {
    return { stage: 3, angle: 'product_benefit_easy_decision' };
  }

  if (!customer.followup_2_sent && elapsed >= 4 * 60 * 60 * 1000) {
    return { stage: 2, angle: 'trust_authenticity_proof' };
  }

  if (!customer.followup_1_sent && elapsed >= 30 * 60 * 1000) {
    return { stage: 1, angle: 'reserve_stock_reminder' };
  }

  return { stage: null, reason: 'no follow-up due yet' };
}

function selectFollowUpProduct(customer, products) {
  if (!customer.last_product || !Array.isArray(products) || !products.length) {
    return null;
  }

  const matches = rankProductMatches(products, customer.last_product, customer.last_product);
  return matches[0] || null;
}

function buildFollowUpMessage(stage, languageStyle, customer, product) {
  if (stage === 1) {
    return getTextByLanguage(languageStyle, {
      english: 'I can reserve this product for you if you want 😊 Stock can change quickly, so confirming early is better.',
      bangla: 'আপনি চাইলে আমি এই productটা আপনার জন্য reserve করে রাখতে পারি 😊 Stock change হতে পারে, তাই confirm করলে better হবে.',
      banglish: 'Apni chaile ami product ta apnar jonno reserve kore rakhte pari 😊 Stock change hote pare, tai confirm korle better hobe.',
      mixed: 'আপনি চাইলে আমি এই productটা আপনার জন্য reserve করে রাখতে পারি 😊 Stock change হতে পারে, tai confirm korle better hobe.'
    });
  }

  if (stage === 2) {
    return getTextByLanguage(languageStyle, {
      english: 'One important thing — UK Brand Lover provides 100% original UK products with proof ✅ So you do not need to worry about authenticity. You can check the proof before confirming your order.',
      bangla: 'আরেকটা important কথা — UK Brand Lover এ আমরা 100% original UK product দিই proof সহ ✅ তাই authenticity নিয়ে tension করার দরকার নেই. চাইলে product proof দেখেই order confirm করতে পারবেন.',
      banglish: 'Ekta important kotha — UK Brand Lover 100% original UK product proof shoho dey ✅ Authenticity niye tension korar dorkar nei. Chaile proof dekhe order confirm korte parben.',
      mixed: 'আরেকটা important কথা — UK Brand Lover 100% original UK product proof সহ দেয় ✅ Authenticity নিয়ে tension করার দরকার নেই. চাইলে proof দেখেই order confirm করতে পারবেন.'
    });
  }

  if (stage === 3) {
    return formatFollowUpStageThree(languageStyle, customer, product);
  }

  return null;
}

function formatFollowUpStageThree(languageStyle, customer, product) {
  const productName = product?.display_name || customer.last_product || 'This product';
  const notes = getFollowUpProductFeature(languageStyle, product, customer.last_product_notes);
  const price = getField(product || {}, 'price', 'regular_price', 'sale_price');
  const stock = getField(product || {}, 'stock', 'availability', 'status');
  const delivery = formatDeliveryCharge(product || {}, languageStyle);
  const decisionText = getTextByLanguage(languageStyle, {
    english: `${productName} is a good choice if you want an original UK product ✅ ${notes}`,
    bangla: `${productName} যারা original UK product চান তাদের জন্য ভালো choice ✅ ${notes}`,
    banglish: `${productName} original UK product chaile good choice ✅ ${notes}`,
    mixed: `${productName} original UK product চাইলে good choice ✅ ${notes}`
  });
  const easyOrderText = getTextByLanguage(languageStyle, {
    english: 'I can make the order process easy for you — just send your name, phone number, and address.',
    bangla: 'চাইলে আমি order processটা easy করে দিচ্ছি — শুধু name, phone number আর address দিলেই হবে.',
    banglish: 'Order process easy — just name, phone number, address dilei hobe.',
    mixed: 'চাইলে আমি order processটা easy করে দিচ্ছি — just name, phone number আর address দিলেই হবে.'
  });

  return [
    decisionText,
    price ? getPriceLine(productName, price, languageStyle) : null,
    stock ? getStockLine(stock, languageStyle) : null,
    delivery,
    easyOrderText
  ]
    .filter(Boolean)
    .join('\n');
}

function getFollowUpProductFeature(languageStyle, product, storedNotes) {
  const notes = firstDefined(getField(product || {}, 'notes', 'note', 'description'), storedNotes);

  if (notes) {
    return notes;
  }

  return getTextByLanguage(languageStyle, {
    english: 'Quality and authenticity are checked carefully.',
    bangla: 'Quality এবং authenticity - দুটোই check করে দেওয়া হয়.',
    banglish: 'Quality ar authenticity carefully check kora hoy.',
    mixed: 'Quality এবং authenticity carefully check kora hoy.'
  });
}

async function markFollowUpSent(psid, stage, angle) {
  const nowIso = new Date().toISOString();
  const updateData = {
    last_followup_angle: angle
  };

  if (stage === 1) {
    updateData.followup_1_sent = true;
    updateData.followup_1_sent_at = nowIso;
  }

  if (stage === 2) {
    updateData.followup_2_sent = true;
    updateData.followup_2_sent_at = nowIso;
  }

  if (stage === 3) {
    updateData.followup_3_sent = true;
    updateData.followup_3_sent_at = nowIso;
  }

  const { error } = await supabase
    .from('customers')
    .update(updateData)
    .eq('psid', psid);

  if (error) {
    throw error;
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

  const normalized = Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      String(key).trim().toLowerCase().replace(/\s+/g, '_'),
      value
    ])
  );

  return enrichProductRow(normalized);
}

function enrichProductRow(product) {
  const displayName = getProductName(product);

  return {
    ...product,
    display_name: displayName,
    searchable_text: [
      displayName,
      getField(product, 'keywords', 'keyword', 'tags'),
      getField(product, 'notes', 'note', 'description'),
      getField(product, 'size', 'variant', 'volume')
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
  };
}

function detectIntent(messageText) {
  const text = String(messageText || '').toLowerCase();

  if (/(which one|what do you have|ki ki ache|ki ache|available products|show products)/i.test(text)) {
    return 'list_products';
  }

  if (/(price koto|দাম কত|কত টাকা|price|dam|দাম|koto|কত)/i.test(text)) {
    return 'price_query';
  }

  if (/(delivery charge|delivery|shipping|courier|dhaka|outside dhaka|location|address|delivery koto)/i.test(text)) {
    return 'delivery_query';
  }

  if (/(total|mot koto|full total|sob mile|shob mile)/i.test(text)) {
    return 'total_query';
  }

  if (/(proof|authenticity|authentic|original naki|original\)/i.test(text)) {
    return 'proof_query';
  }

  if (/(available|ache|আছে|stock|ase|আছে নাকি)/i.test(text)) {
    return 'availability_query';
  }

  if (/\b\d+\s?(ml|gm|g|kg|l|oz|pcs|pc)\b/i.test(text)) {
    return 'size_query';
  }

  if (/(order|reserve|book koren|book|lagbe|লাগবে|nibo|নিবো|nite chai|নিতে চাই|nbo|confirm)/i.test(text)) {
    return 'order_intent';
  }

  return 'product_query';
}

function rankProductMatches(products, messageText, lastProduct) {
  const query = `${messageText || ''} ${lastProduct || ''}`.toLowerCase();
  const tokens = tokenizeSearch(query);

  return products
    .map((product) => ({
      ...product,
      _score: scoreProductMatch(product, query, tokens, lastProduct)
    }))
    .filter((product) => product._score > 0)
    .sort((a, b) => b._score - a._score);
}

function scoreProductMatch(product, query, tokens, lastProduct) {
  const productName = getProductName(product).toLowerCase();
  const keywords = String(getField(product, 'keywords', 'keyword', 'tags') || '').toLowerCase();
  const notes = String(getField(product, 'notes', 'note', 'description') || '').toLowerCase();
  const searchable = [productName, keywords, notes, product.searchable_text || ''].join(' ');
  let score = 0;

  if (!query.trim()) {
    return 0;
  }

  if (productName && query.includes(productName)) {
    score += 120;
  }

  if (lastProduct && productName.includes(String(lastProduct).toLowerCase())) {
    score += 60;
  }

  for (const token of tokens) {
    if (token.length < 2) {
      continue;
    }

    if (productName.includes(token)) {
      score += 20;
    } else if (keywords.includes(token)) {
      score += 12;
    } else if (notes.includes(token)) {
      score += 8;
    } else if (searchable.includes(token)) {
      score += 5;
    }
  }

  return score;
}

function tokenizeSearch(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9\u0980-\u09ff]+/)
    .filter(Boolean);
}

function getProductName(product) {
  return getField(product, 'product_name', 'name', 'title', 'product') || 'Product';
}

function getField(product, ...keys) {
  for (const key of keys) {
    const value = product[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return String(value).trim();
    }
  }

  return null;
}

function formatProductSalesReply(product, languageStyle, intent, messageText, customer) {
  const name = product.display_name;
  const price = getField(product, 'price', 'regular_price', 'sale_price');
  const stock = getField(product, 'stock', 'availability', 'status');
  const delivery = formatDeliveryCharge(product, languageStyle);
  const availableLine = getAvailabilityLine(name, price, languageStyle);
  const priceText = getPriceLine(name, price, languageStyle);
  const stockText = stock ? getStockLine(stock, languageStyle) : null;
  const trustText = getTrustLine(languageStyle);
  const softPriceCta = getPriceSoftCta(languageStyle);
  const reserveCta = getReserveCta(languageStyle, intent);
  const wantsDelivery = intent === 'delivery_query';
  const wantsTotal = intent === 'total_query';
  const wantsProof = intent === 'proof_query';
  const wantsAvailability = intent === 'availability_query';
  const priceOnly = intent === 'price_query';

  if (wantsDelivery) {
    return [
      delivery || getDeliveryUnavailableReply(languageStyle),
      trustText,
      getDeliveryFollowupCta(languageStyle)
    ].filter(Boolean).join('\n');
  }

  if (wantsTotal) {
    return [
      availableLine,
      priceText,
      delivery || getDeliveryUnavailableReply(languageStyle),
      getTotalFollowupReply(languageStyle, customer?.address)
    ].filter(Boolean).join('\n');
  }

  if (wantsProof) {
    return [
      availableLine,
      trustText,
      getProofOfferReply(languageStyle)
    ].filter(Boolean).join('\n');
  }

  if (wantsAvailability) {
    return [
      availableLine,
      stockText,
      trustText,
      getAvailabilityFollowupCta(languageStyle)
    ].filter(Boolean).join('\n');
  }

  if (priceOnly || intent === 'size_query') {
    return [
      availableLine,
      null,
      priceText,
      trustText,
      softPriceCta
    ].filter(Boolean).join('\n');
  }

  return [
    availableLine,
    priceText,
    shouldIncludeDeliveryForIntent(intent, messageText, customer) ? delivery : null,
    trustText,
    stock ? getScarcityLine(languageStyle) : null,
    reserveCta
  ].filter(Boolean).join('\n');
}

function formatProductListReply(products, languageStyle) {
  const intro = getProductListIntro(languageStyle);

  const list = products.slice(0, 3).map((product) => {
    const price = getField(product, 'price', 'regular_price', 'sale_price');
    return price
      ? `${product.display_name} - ${price}`
      : `${product.display_name} - ${getTextByLanguage(languageStyle, {
        english: 'price on request',
        bangla: 'দাম team confirm করবে',
        banglish: 'price team confirm korbe',
        mixed: 'price team confirm korbe'
      })}`;
  });

  return [
    intro,
    ...list,
    getTrustLine(languageStyle),
    getTextByLanguage(languageStyle, {
      english: 'Would you like the details? 😊',
      bangla: 'আপনি চাইলে details দিতে পারি 😊',
      banglish: 'Apni chaile details dite pari 😊',
      mixed: 'আপনি চাইলে details dite pari 😊'
    })
  ].join('\n');
}

function formatDeliveryCharge(product, languageStyle) {
  const dhaka = getField(product, 'delivery_dhaka', 'dhaka_delivery', 'dhaka_charge');
  const outsideDhaka = getField(product, 'delivery_outside_dhaka', 'outside_dhaka_delivery', 'outside_dhaka_charge');
  const single = getField(product, 'delivery_charge', 'delivery', 'shipping');

  if (dhaka && outsideDhaka) {
    return getTextByLanguage(languageStyle, {
      english: `Delivery: Dhaka ${dhaka}, outside Dhaka ${outsideDhaka}`,
      bangla: `ডেলিভারি: ঢাকা ${dhaka}, ঢাকার বাইরে ${outsideDhaka}`,
      banglish: `Delivery: Dhaka ${dhaka}, outside Dhaka ${outsideDhaka}`,
      mixed: `ডেলিভারি: Dhaka ${dhaka}, outside Dhaka ${outsideDhaka}`
    });
  }

  if (single) {
    return getTextByLanguage(languageStyle, {
      english: `Delivery: ${single}`,
      bangla: `ডেলিভারি: ${single}`,
      banglish: `Delivery: ${single}`,
      mixed: `ডেলিভারি: ${single}`
    });
  }

  return null;
}

function detectLanguageStyle(text) {
  const value = String(text || '');
  const lower = value.toLowerCase();
  const hasBanglaScript = /[\u0980-\u09ff]/.test(value);
  const englishWords = (lower.match(/[a-z]+/g) || []).length;
  const banglishHints = /(apni|ami|acha|ache|ase|lagbe|nibo|koto|dam|chaile|koren|dite|pari|bolen|nai|thakbe|naki|ji|eta|etao|kon|den)/i.test(lower);

  if (hasBanglaScript && englishWords > 0) {
    return 'mixed';
  }

  if (hasBanglaScript) {
    return 'bangla';
  }

  if (banglishHints) {
    return 'banglish';
  }

  return 'english';
}

function isNotInterestedMessage(text) {
  return /(not interested|dont need|don't need|need nai|lagbe na|nibo na|dorkar nei|প্রয়োজন নেই|interest nei|no thanks)/i.test(text || '');
}

function isLaterMessage(text) {
  return /(later|pore|poray|ekhon na|later janabo|pore janabo|after e|porer dike)/i.test(text || '');
}

function getTextByLanguage(languageStyle, variants) {
  return variants[languageStyle] || variants.english;
}

function getNotInterestedReply(languageStyle) {
  return getTextByLanguage(languageStyle, {
    english: 'No problem 😊 Let us know anytime if you need it later.',
    bangla: 'ঠিক আছে 😊 কোনো সমস্যা নেই. ভবিষ্যতে দরকার হলে জানাবেন.',
    banglish: 'Thik ache 😊 kono problem nei. Future e dorkar hole janaben.',
    mixed: 'ঠিক আছে 😊 কোনো problem নেই. Future এ দরকার হলে জানাবেন.'
  });
}

function getLaterReply(languageStyle) {
  return getTextByLanguage(languageStyle, {
    english: 'Sure 😊 Take your time. Just message us whenever you want to continue.',
    bangla: 'অবশ্যই 😊 আপনি সময় নিয়ে দেখুন. পরে চাইলে message দিলেই আমি help করব.',
    banglish: 'Sure 😊 Apni time niye dekhun. Pore chaile message dilei ami help korbo.',
    mixed: 'Sure 😊 আপনি time নিয়ে দেখুন. পরে চাইলে message দিলেই আমি help করব.'
  });
}

function getSensitiveInfoReply(languageStyle) {
  return getTextByLanguage(languageStyle, {
    english: 'Please do not share OTP, password, card number, or PIN here. For your safety, keep this information private.',
    bangla: 'অনুগ্রহ করে এখানে OTP, password, card number বা PIN শেয়ার করবেন না। আপনার নিরাপত্তার জন্য এসব তথ্য private রাখুন।',
    banglish: 'Please ekhane OTP, password, card number, ba PIN share korben na. Nijer safety r jonno egula private rakhun.',
    mixed: 'অনুগ্রহ করে এখানে OTP, password, card number বা PIN share করবেন না। Safety র জন্য এগুলো private রাখুন।'
  });
}

function getFallbackReply(languageStyle) {
  return getTextByLanguage(languageStyle, {
    english: 'Thanks for messaging UK Brand Lover. Please send the product name, and I will help you shortly.',
    bangla: 'UK Brand Lover-এ message করার জন্য ধন্যবাদ। Product name টি পাঠান, আমি shorty help করছি।',
    banglish: 'UK Brand Lover e message korar jonno dhonnobad. Product name ta pathan, ami shortly help korchi.',
    mixed: 'UK Brand Lover-এ message করার জন্য ধন্যবাদ। Product name ta pathan, ami shortly help করছি.'
  });
}

function getKnownProductPriceFallback(productName, languageStyle) {
  return getTextByLanguage(languageStyle, {
    english: `I can help with the price for ${productName}. Please send the exact product name in one line so I can confirm the latest match 😊`,
    bangla: `${productName} এর price confirm করে বলছি। Exact product name টি ১ লাইনে পাঠালে latest match check করতে পারি 😊`,
    banglish: `${productName} er price confirm kore bolchi. Exact product name ta 1 line e pathale latest match check korte pari 😊`,
    mixed: `${productName} এর price confirm kore bolchi. Exact product name ta 1 line e pathale latest match check korte pari 😊`
  });
}

function getSizeClarificationReply(languageStyle) {
  return getTextByLanguage(languageStyle, {
    english: 'Which product size do you mean? Please send the product name in one line.',
    bangla: 'কোন product-এর size বলছেন? Product name টি ১ লাইনে পাঠান।',
    banglish: 'Kon product er size bolchen? Product name ta 1 line e pathan.',
    mixed: 'কোন product er size bolchen? Product name ta 1 line e pathan.'
  });
}

function getAvailabilityLine(name, price, languageStyle) {
  const statusWord = price ? 'available ✅' : 'available';
  return getTextByLanguage(languageStyle, {
    english: `Yes, ${name} is ${statusWord}`,
    bangla: `জি, ${name} available আছে ✅`,
    banglish: `Ji, ${name} available ache ✅`,
    mixed: `জি, ${name} available আছে ✅`
  });
}

function getPriceLine(name, price, languageStyle) {
  if (!price) {
    return getTextByLanguage(languageStyle, {
      english: 'This product is available, but I need to confirm the latest price from our team.',
      bangla: 'এই product available আছে, তবে latest price team থেকে confirm করতে হবে।',
      banglish: 'Ei product available ache, but latest price team theke confirm korte hobe.',
      mixed: 'এই product available আছে, but latest price team থেকে confirm করতে হবে।'
    });
  }

  return getTextByLanguage(languageStyle, {
    english: `Price: ${price}`,
    bangla: `দাম: ${price}`,
    banglish: `Price: ${price}`,
    mixed: `দাম: ${price}`
  });
}

function getStockLine(stock, languageStyle) {
  return getTextByLanguage(languageStyle, {
    english: `Stock: ${stock}`,
    bangla: `স্টক: ${stock}`,
    banglish: `Stock: ${stock}`,
    mixed: `স্টক: ${stock}`
  });
}

function getTrustLine(languageStyle) {
  return getTextByLanguage(languageStyle, {
    english: "It's 100% original UK product with proof.",
    bangla: 'এটা 100% original UK product with proof.',
    banglish: 'Eta 100% original UK product with proof.',
    mixed: 'এটা 100% original UK product with proof.'
  });
}

function getScarcityLine(languageStyle) {
  return getTextByLanguage(languageStyle, {
    english: 'Stock can change quickly, so I can reserve it for you if you want.',
    bangla: 'স্টক দ্রুত change হতে পারে, চাইলে আমি আপনার জন্য reserve করে দিতে পারি।',
    banglish: 'Stock quickly change hote পারে, chaile ami apnar jonno reserve kore dite pari.',
    mixed: 'স্টক quickly change হতে পারে, চাইলে আমি আপনার জন্য reserve করে দিতে পারি।'
  });
}

function getReserveCta(languageStyle, intent) {
  const key = intent === 'size_query' ? 'size' : 'default';
  const variants = {
    default: {
      english: 'Would you like me to reserve 1 piece for you?',
      bangla: 'আপনি চাইলে আমি ১ পিস reserve করে দিতে পারি।',
      banglish: 'Apni chaile ami 1 piece reserve kore dite pari.',
      mixed: 'আপনি চাইলে আমি 1 piece reserve করে দিতে পারি।'
    },
    size: {
      english: 'Do you want to confirm 1 piece?',
      bangla: 'আপনি কি ১ পিস confirm করতে চান?',
      banglish: 'Apni ki 1 piece confirm korte chan?',
      mixed: 'আপনি কি 1 piece confirm করতে চান?'
    }
  };

  return getTextByLanguage(languageStyle, variants[key]);
}

function getPriceSoftCta(languageStyle) {
  return getTextByLanguage(languageStyle, {
    english: 'Would you like me to show you the proof or reserve 1 piece?',
    bangla: 'আপনি চাইলে proof দেখাতে পারি অথবা ১ পিস reserve করে দিতে পারি।',
    banglish: 'Chaile proof dekhate pari or 1 piece reserve kore dite pari.',
    mixed: 'আপনি চাইলে proof দেখাতে পারি অথবা 1 piece reserve করে দিতে পারি।'
  });
}

function getAvailabilityFollowupCta(languageStyle) {
  return getTextByLanguage(languageStyle, {
    english: 'Would you like the price as well?',
    bangla: 'চাইলে দামটাও জানিয়ে দিচ্ছি।',
    banglish: 'Chaile price tao janiye dicchi.',
    mixed: 'চাইলে price tao জানিয়ে দিচ্ছি।'
  });
}

function getProofOfferReply(languageStyle) {
  return getTextByLanguage(languageStyle, {
    english: 'I can show you the proof before you decide.',
    bangla: 'আপনি চাইলে confirm করার আগে proof দেখাতে পারি।',
    banglish: 'Chaile confirm korar age proof dekhate pari.',
    mixed: 'আপনি চাইলে confirm করার আগে proof দেখাতে পারি।'
  });
}

function getDeliveryFollowupCta(languageStyle) {
  return getTextByLanguage(languageStyle, {
    english: 'If you want, I can also share the price or keep 1 piece reserved for you.',
    bangla: 'চাইলে আমি দামটাও জানাতে পারি বা ১ পিস reserve করে রাখতে পারি।',
    banglish: 'Chaile ami price tao janate pari ba 1 piece reserve kore rakhte pari.',
    mixed: 'চাইলে আমি price tao জানাতে পারি বা 1 piece reserve করে রাখতে পারি।'
  });
}

function getDeliveryUnavailableReply(languageStyle) {
  return getTextByLanguage(languageStyle, {
    english: 'I need to confirm the latest delivery charge from our team.',
    bangla: 'Latest delivery charge team থেকে confirm করতে হবে।',
    banglish: 'Latest delivery charge team theke confirm korte hobe.',
    mixed: 'Latest delivery charge team থেকে confirm করতে হবে।'
  });
}

function getTotalFollowupReply(languageStyle, address) {
  if (address) {
    return getTextByLanguage(languageStyle, {
      english: 'If you share the exact location, I can confirm the full total properly.',
      bangla: 'Exact location দিলে full totalটা ঠিকভাবে confirm করে দিতে পারি।',
      banglish: 'Exact location dile full total ta thikvabe confirm kore dite pari.',
      mixed: 'Exact location দিলে full totalটা ঠিকভাবে confirm kore dite pari.'
    });
  }

  return getTextByLanguage(languageStyle, {
    english: 'Share your location and I will confirm the full total for you.',
    bangla: 'Location দিলে full totalটা confirm করে দিতে পারি।',
    banglish: 'Location dile full total ta confirm kore dite pari.',
    mixed: 'Location দিলে full totalটা confirm kore dite pari.'
  });
}

function getOrderCollectionReply(languageStyle) {
  return getTextByLanguage(languageStyle, {
    english: 'Perfect. Please send your name, phone number, full address, and quantity.',
    bangla: 'ঠিক আছে। আপনার name, phone number, full address আর quantity পাঠিয়ে দিন।',
    banglish: 'Thik ache. Apnar name, phone number, full address ar quantity pathiye din.',
    mixed: 'ঠিক আছে। আপনার name, phone number, full address আর quantity pathiye din.'
  });
}

function shouldIncludeDeliveryForIntent(intent, messageText, customer) {
  return intent === 'delivery_query'
    || intent === 'total_query'
    || intent === 'order_intent'
    || /delivery|shipping|courier|dhaka|location|address/i.test(messageText || '')
    || Boolean(customer?.address);
}

function getProductListIntro(languageStyle) {
  return getTextByLanguage(languageStyle, {
    english: 'These matching products are available ✅',
    bangla: 'এই matching products গুলো available আছে ✅',
    banglish: 'Ei matching products gulo available ache ✅',
    mixed: 'এই matching products গুলো available আছে ✅'
  });
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

setInterval(() => {
  processPendingFollowUps().catch((error) => {
    console.error('Scheduled follow-up error:', error.message, error.details || '');
  });
}, 5 * 60 * 1000);

setTimeout(() => {
  processPendingFollowUps().catch((error) => {
    console.error('Initial follow-up scan error:', error.message, error.details || '');
  });
}, 10000);

app.listen(PORT, () => {
  console.log(`Messenger AI Bot listening on port ${PORT}`);
});

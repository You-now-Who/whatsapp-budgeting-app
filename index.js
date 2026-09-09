const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { google } = require('googleapis');
const axios = require('axios');

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox'
        ]
    }
});
const GC_NAME = 'Yash SMS Banking';

// ─── SPEND PARSING ───────────────────────────────────────────────────────────

const CURRENCY_SYMBOLS = { '£': 'GBP', '€': 'EUR', '₹': 'INR', '$': 'USD' };

function extractSpend(text) {
  const t = text.toLowerCase();

  // Tier 1a: symbol prefix — £150, €50, ₹1500
  const symbolPrefix = text.match(/([£€₹$])\s*([\d,]+(?:\.\d{1,2})?)/);
  if (symbolPrefix) return { amount: parseFloat(symbolPrefix[2].replace(/,/g, '')), currency: CURRENCY_SYMBOLS[symbolPrefix[1]] };

  // Tier 1b: number + currency word — 150 GBP, 1500 INR, 50 EUR
  const currencyWord = text.match(/([\d,]+(?:\.\d{1,2})?)\s*(GBP|INR|EUR|USD)/i);
  if (currencyWord) return { amount: parseFloat(currencyWord[1].replace(/,/g, '')), currency: currencyWord[2].toUpperCase() };

  // Tier 2: spend verb + number — "spent 200", "paid 1500", "cost me 300", "cost 300"
  const spendVerb = t.match(/(?:spent|paid|cost(?:\s+me)?|paying)\s+(?:like\s+|about\s+|around\s+|ish\s+)?([\d,]+(?:\.\d{1,2})?)/);
  if (spendVerb) return { amount: parseFloat(spendVerb[1].replace(/,/g, '')), currency: 'GBP' };

  // Tier 3: number + "for/on" context — "1593 for pasta", "200 on groceries"
  const numContext = t.match(/([\d,]+(?:\.\d{1,2})?)\s+(?:ish\s+)?(?:for|on)\s+\w/);
  if (numContext) return { amount: parseFloat(numContext[1].replace(/,/g, '')), currency: 'GBP' };

  return null;
}

// ─── EXCHANGE RATE ────────────────────────────────────────────────────────────

async function getGBPtoINR() {
  // Free, no API key needed
  const res = await axios.get('https://open.er-api.com/v6/latest/GBP');
  return res.data.rates.INR;
}

// ─── GOOGLE SHEETS ────────────────────────────────────────────────────────────

// REPLACE with your sheet ID
const SHEET_ID = '1ww6AOa0UMu5ImWn-m8ZhBxT1enQphWU_XigpUjq8GX8';
const SHEET_NAME = 'Expenses';

async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: 'secrets/private-key.json', // service account JSON
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function logExpense(amount, currency, rawText) {
  const sheets = await getSheetsClient();
  const now = new Date();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:D`,
    valueInputOption: 'USER_ENTERED',
    resource: {
      values: [[now.toISOString(), rawText.slice(0, 80), amount, currency]],
    },
  });
}

async function getMonthlyTotal() {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:D`,
  });

  const rows = res.data.values || [];
  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  let totalGBP = 0;
  for (const [date, , amount, currency] of rows.slice(1)) { // skip header
    if (!date?.startsWith(thisMonth)) continue;
    const val = parseFloat(amount) || 0;
    if (currency === 'GBP') totalGBP += val;
    else if (currency === 'INR') totalGBP += val / (await getGBPtoINR()); // convert back
    else if (currency === 'EUR') totalGBP += val * 0.86; // rough, or fetch EUR→GBP too
  }

  return totalGBP;
}

// ─── BOT LOGIC ────────────────────────────────────────────────────────────────

client.on('qr', qr => qrcode.generate(qr, { small: true }));

client.on('message', async msg => {
  try {
    const chat = await msg.getChat();
    if (!chat.isGroup || chat.name !== GC_NAME) return;

    // -<amount> gbp — log a GBP reduction (refund/correction)
    const reduceMatch = msg.body.match(/^-([\d,]+(?:\.\d{1,2})?)\s*gbp$/i);
    if (reduceMatch) {
      const amount = parseFloat(reduceMatch[1].replace(/,/g, ''));
      try {
        await logExpense(-amount, 'GBP', msg.body);
        const [monthTotal, rate] = await Promise.all([getMonthlyTotal(), getGBPtoINR()]);
        await msg.reply(
          `↩️ Reduced: £${amount.toFixed(2)}\n` +
          `📊 Month so far: £${monthTotal.toFixed(2)} (₹${(monthTotal * rate).toFixed(0)})\n` +
          `💱 GBP → INR: ${rate.toFixed(2)}`
        );
      } catch (err) {
        console.error('Error handling GBP reduction:', err);
      }
      return;
    }

    const spend = extractSpend(msg.body);
    if (!spend) return;

    try {
      await logExpense(spend.amount, spend.currency, msg.body);

      const [monthTotal, rate] = await Promise.all([getMonthlyTotal(), getGBPtoINR()]);

      const reply =
        `✅ Logged: ${spend.amount} ${spend.currency}\n` +
        `📊 Month so far: £${monthTotal.toFixed(2)} (₹${(monthTotal * rate).toFixed(0)})\n` +
        `💱 GBP → INR: ${rate.toFixed(2)}`;

      await msg.reply(reply);
    } catch (err) {
      console.error('Error handling spend message:', err);
    } 
  } catch (error) {
    console.error("Error handling WhatsApp message:", err);
  }
});

client.on('ready', () => console.log('Bot ready'));
client.initialize();

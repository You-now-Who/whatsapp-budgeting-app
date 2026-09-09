const makeWASocket =
    require('@whiskeysockets/baileys').default;

const {
    useMultiFileAuthState,
    DisconnectReason,
} = require('@whiskeysockets/baileys');

const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const { google } = require('googleapis');
const axios = require('axios');


// ============================================================
// CONFIG
// ============================================================

const GC_NAME = 'Yash SMS Banking';

// Leave this empty on the first run.
// The bot will print your group's JID.
// Then put that JID here.
//
// Example:
// const GC_ID = '12036312...@g.us';

const GC_ID = '';


// ============================================================
// CURRENCY
// ============================================================

const CURRENCY_SYMBOLS = {
    '£': 'GBP',
    '€': 'EUR',
    '₹': 'INR',
    '$': 'USD'
};


// ============================================================
// EXPENSE PARSER
// ============================================================

function extractSpend(text) {
    const t = text.toLowerCase();

    // £20 / €20 / ₹500 / $20
    const symbolPrefix = text.match(
        /([£€₹$])\s*([\d,]+(?:\.\d{1,2})?)/
    );

    if (symbolPrefix) {
        return {
            amount: parseFloat(
                symbolPrefix[2].replace(/,/g, '')
            ),
            currency: CURRENCY_SYMBOLS[symbolPrefix[1]]
        };
    }

    // 20 GBP / 500 INR / 20 EUR / 20 USD
    const currencyWord = text.match(
        /([\d,]+(?:\.\d{1,2})?)\s*(GBP|INR|EUR|USD)/i
    );

    if (currencyWord) {
        return {
            amount: parseFloat(
                currencyWord[1].replace(/,/g, '')
            ),
            currency: currencyWord[2].toUpperCase()
        };
    }

    // spent 20
    // paid 20
    // cost me 20
    // paying 20
    const spendVerb = t.match(
        /(?:spent|paid|cost(?:\s+me)?|paying)\s+(?:like\s+|about\s+|around\s+|ish\s+)?([\d,]+(?:\.\d{1,2})?)/
    );

    if (spendVerb) {
        return {
            amount: parseFloat(
                spendVerb[1].replace(/,/g, '')
            ),
            currency: 'GBP'
        };
    }

    // 20 for food
    // 20 on lunch
    const numContext = t.match(
        /([\d,]+(?:\.\d{1,2})?)\s+(?:ish\s+)?(?:for|on)\s+\w/
    );

    if (numContext) {
        return {
            amount: parseFloat(
                numContext[1].replace(/,/g, '')
            ),
            currency: 'GBP'
        };
    }

    return null;
}


// ============================================================
// EXCHANGE RATE
// ============================================================

async function getGBPtoINR() {
    const res = await axios.get(
        'https://open.er-api.com/v6/latest/GBP'
    );

    return res.data.rates.INR;
}


// ============================================================
// GOOGLE SHEETS
// ============================================================

const SHEET_ID =
    '1ww6AOa0UMu5ImWn-m8ZhBxT1enQphWU_XigpUjq8GX8';

const SHEET_NAME = 'Expenses';


async function getSheetsClient() {
    const auth = new google.auth.GoogleAuth({
        keyFile: 'secrets/private-key.json',

        scopes: [
            'https://www.googleapis.com/auth/spreadsheets'
        ],
    });

    return google.sheets({
        version: 'v4',
        auth
    });
}


// ============================================================
// LOG EXPENSE
// ============================================================

async function logExpense(
    amount,
    currency,
    rawText
) {
    const sheets = await getSheetsClient();

    const now = new Date();

    await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,

        range: `${SHEET_NAME}!A:D`,

        valueInputOption: 'USER_ENTERED',

        resource: {
            values: [[
                now.toISOString(),
                rawText.slice(0, 80),
                amount,
                currency
            ]],
        },
    });
}


// ============================================================
// MONTHLY TOTAL
// ============================================================

async function getMonthlyTotal() {
    const sheets = await getSheetsClient();

    const res =
        await sheets.spreadsheets.values.get({
            spreadsheetId: SHEET_ID,
            range: `${SHEET_NAME}!A:D`,
        });

    const rows = res.data.values || [];

    const now = new Date();

    const thisMonth =
        `${now.getFullYear()}-${String(
            now.getMonth() + 1
        ).padStart(2, '0')}`;

    let totalGBP = 0;

    for (
        const [date, , amount, currency]
        of rows.slice(1)
    ) {
        if (!date?.startsWith(thisMonth)) {
            continue;
        }

        const val =
            parseFloat(amount) || 0;

        if (currency === 'GBP') {
            totalGBP += val;
        }

        else if (currency === 'INR') {
            totalGBP +=
                val / await getGBPtoINR();
        }

        else if (currency === 'EUR') {
            totalGBP += val * 0.86;
        }

        // Keeping the original behaviour:
        // USD isn't converted yet.
    }

    return totalGBP;
}


// ============================================================
// GET MESSAGE TEXT
// ============================================================

function getMessageText(message) {
    return (
        message.message?.conversation ||

        message.message
            ?.extendedTextMessage
            ?.text ||

        ''
    );
}


// ============================================================
// SEND MESSAGE
// ============================================================

async function sendReply(
    sock,
    jid,
    text
) {
    await sock.sendMessage(
        jid,
        {
            text
        }
    );
}


// ============================================================
// WHATSAPP CONNECTION
// ============================================================

async function connectToWhatsApp() {

    const {
        state,
        saveCreds
    } = await useMultiFileAuthState(
        './baileys_auth'
    );


    const sock = makeWASocket({

        auth: state,

        markOnlineOnConnect: false,

    });


    // Save authentication credentials
    sock.ev.on(
        'creds.update',
        saveCreds
    );


    // ========================================================
    // CONNECTION EVENTS
    // ========================================================

    sock.ev.on(
        'connection.update',
        (update) => {

            const {
                connection,
                lastDisconnect,
                qr
            } = update;


            // ------------------------------------------------
            // QR CODE
            // ------------------------------------------------

            if (qr) {

                console.log(
                    '\nScan this QR code with WhatsApp:\n'
                );

                qrcode.generate(
                    qr,
                    {
                        small: true
                    }
                );
            }


            // ------------------------------------------------
            // CONNECTED
            // ------------------------------------------------

            if (connection === 'open') {

                console.log(
                    '\n================================='
                );

                console.log(
                    'Bot ready — connected to WhatsApp'
                );

                console.log(
                    '=================================\n'
                );
            }


            // ------------------------------------------------
            // DISCONNECTED
            // ------------------------------------------------

            if (connection === 'close') {

                const statusCode =
                    new Boom(
                        lastDisconnect?.error
                    )?.output?.statusCode;


                const shouldReconnect =
                    statusCode !==
                    DisconnectReason.loggedOut;


                console.log(
                    'WhatsApp connection closed.'
                );

                console.log(
                    'Reconnecting:',
                    shouldReconnect
                );


                if (shouldReconnect) {

                    connectToWhatsApp();

                }

                else {

                    console.log(
                        '\nLogged out of WhatsApp.'
                    );

                    console.log(
                        'Delete ./baileys_auth and run the bot again to re-link.\n'
                    );
                }
            }
        }
    );


    // ========================================================
    // INCOMING MESSAGES
    // ========================================================

    sock.ev.on(
        'messages.upsert',
        async ({ messages }) => {

            for (const msg of messages) {

                try {

                    // Ignore messages without content
                    if (!msg.message) {
                        continue;
                    }


                    // Don't process our own messages
                    if (msg.key.fromMe) {
                        continue;
                    }


                    // The chat/group JID
                    const jid =
                        msg.key.remoteJid;


                    if (!jid) {
                        continue;
                    }


                    // Ignore WhatsApp status
                    if (
                        jid === 'status@broadcast' ||
                        jid.endsWith('@broadcast')
                    ) {
                        continue;
                    }


                    // ====================================================
                    // GROUP ID DISCOVERY
                    // ====================================================

                    if (jid.endsWith('@g.us')) {

                        console.log(
                            `Group message from: ${jid}`
                        );


                        // If we haven't configured the group yet,
                        // print its ID and ignore the message.

                        if (!GC_ID) {

                            console.log(
                                'GC_ID is empty.'
                            );

                            console.log(
                                `Use this as GC_ID: ${jid}`
                            );

                            continue;
                        }
                    }


                    // ====================================================
                    // ONLY OUR BUDGET GROUP
                    // ====================================================

                    if (jid !== GC_ID) {
                        continue;
                    }


                    // ====================================================
                    // EXTRACT TEXT
                    // ====================================================

                    const text =
                        getMessageText(msg)
                            .trim();


                    if (!text) {
                        continue;
                    }


                    console.log(
                        `Message: ${text}`
                    );


                    // ====================================================
                    // REDUCE EXPENSE
                    //
                    // Example:
                    // -10 GBP
                    // ====================================================

                    const reduceMatch =
                        text.match(
                            /^-([\d,]+(?:\.\d{1,2})?)\s*gbp$/i
                        );


                    if (reduceMatch) {

                        const amount =
                            parseFloat(
                                reduceMatch[1]
                                    .replace(/,/g, '')
                            );


                        await logExpense(
                            -amount,
                            'GBP',
                            text
                        );


                        const [
                            monthTotal,
                            rate
                        ] = await Promise.all([
                            getMonthlyTotal(),
                            getGBPtoINR()
                        ]);


                        await sendReply(
                            sock,
                            jid,

                            `↩️ Reduced: £${amount.toFixed(2)}\n` +
                            `📊 Month so far: £${monthTotal.toFixed(2)} (₹${(monthTotal * rate).toFixed(0)})\n` +
                            `💱 GBP → INR: ${rate.toFixed(2)}`
                        );


                        continue;
                    }


                    // ====================================================
                    // NORMAL EXPENSE
                    // ====================================================

                    const spend =
                        extractSpend(text);


                    if (!spend) {
                        continue;
                    }


                    // Save to Google Sheets

                    await logExpense(
                        spend.amount,
                        spend.currency,
                        text
                    );


                    // Get updated totals

                    const [
                        monthTotal,
                        rate
                    ] = await Promise.all([
                        getMonthlyTotal(),
                        getGBPtoINR()
                    ]);


                    // Build reply

                    const reply =
                        `✅ Logged: ${spend.amount} ${spend.currency}\n` +
                        `📊 Month so far: £${monthTotal.toFixed(2)} (₹${(monthTotal * rate).toFixed(0)})\n` +
                        `💱 GBP → INR: ${rate.toFixed(2)}`;


                    // Send reply

                    await sendReply(
                        sock,
                        jid,
                        reply
                    );

                }


                // ========================================================
                // ERROR HANDLING
                // ========================================================

                catch (err) {

                    console.error(
                        'Error handling WhatsApp message:',
                        err
                    );
                }
            }
        }
    );
}


// ============================================================
// START
// ============================================================

console.log(
    'Starting WhatsApp budgeting bot...'
);

connectToWhatsApp();

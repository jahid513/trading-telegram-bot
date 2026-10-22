require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

// 1. Express app initialization
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 2. Multer memory storage setup (RAM-e process hobe, server storage khoroch hobe na)
const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 } // Shorbocco 10MB file
});

// 3. Firebase Admin SDK initialization
let serviceAccount;
try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        serviceAccount = typeof process.env.FIREBASE_SERVICE_ACCOUNT === 'string'
            ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
            : process.env.FIREBASE_SERVICE_ACCOUNT;
    } else {
        serviceAccount = require('./serviceAccountKey.json');
    }

    if (!getApps().length) {
        initializeApp({
            credential: cert(serviceAccount)
        });
    }
    console.log("Firebase Admin SDK Connected Successfully.");
} catch (error) {
    console.error("Firebase Admin SDK Init Error:", error.message);
}

const db = getFirestore();

// 4. Environment variables & Telegram credentials
const token = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
const adminChatId = process.env.ADMIN_CHAT_ID;

// 5. Native Telegram REST API functions
async function sendTelegramMessage(chatId, text, replyMarkup = null) {
    if (!token) return;
    try {
        const payload = {
            chat_id: chatId,
            text: text,
            parse_mode: 'HTML'
        };
        if (replyMarkup) payload.reply_markup = replyMarkup;

        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
    } catch (e) {
        console.error("sendTelegramMessage Error:", e.message);
    }
}

async function sendTelegramPhoto(chatId, photoBuffer, filename, mimetype, caption, replyMarkup = null) {
    if (!token) return;
    try {
        const formData = new FormData();
        formData.append('chat_id', String(chatId));
        if (caption) {
            formData.append('caption', caption);
            formData.append('parse_mode', 'HTML');
        }
        if (replyMarkup) {
            formData.append('reply_markup', JSON.stringify(replyMarkup));
        }

        const blob = new Blob([photoBuffer], { type: mimetype || 'image/jpeg' });
        formData.append('photo', blob, filename || 'payment_proof.jpg');

        await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
            method: 'POST',
            body: formData
        });
    } catch (e) {
        console.error("sendTelegramPhoto Error:", e.message);
    }
}

async function answerCallbackQuery(queryId, text) {
    if (!token) return;
    try {
        await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ callback_query_id: queryId, text: text })
        });
    } catch (e) {
        console.error("answerCallbackQuery Error:", e.message);
    }
}

// Action neowar por inline button muche fellar function (chobi o text thik thakbe)
async function removeInlineKeyboard(chatId, messageId) {
    if (!token) return;
    try {
        await fetch(`https://api.telegram.org/bot${token}/editMessageReplyMarkup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                message_id: messageId,
                reply_markup: { inline_keyboard: [] }
            })
        });
    } catch (e) {
        console.error("removeInlineKeyboard Error:", e.message);
    }
}

// 6. UptimeRobot monitoring route
app.get('/', (req, res) => {
    res.status(200).send('JH Trading VIP Bot Server is Running');
});

// 7. Quotex Webhook Postback receiver
app.get('/quotex-webhook', async (req, res) => {
    try {
        const { uid, deposit, status } = req.query;
        console.log(`[Quotex Webhook] Received -> UID: ${uid}, Deposit: ${deposit}, Status: ${status}`);

        if (!uid) {
            return res.status(400).send("UID missing");
        }

        const traderIdStr = String(uid).trim();
        const depositNum = parseFloat(deposit) || 0;
        const hasBalance = depositNum > 0 || status === 'success';

        const traderRef = db.collection('quotex_traders').doc(traderIdStr);
        const traderDoc = await traderRef.get();

        if (traderDoc.exists) {
            await traderRef.update({
                hasDeposit: hasBalance,
                totalDeposit: depositNum,
                lastStatus: status || 'updated',
                lastUpdated: FieldValue.serverTimestamp()
            });
        } else {
            await traderRef.set({
                traderId: traderIdStr,
                isAffiliate: true,
                hasDeposit: hasBalance,
                totalDeposit: depositNum,
                registeredAt: FieldValue.serverTimestamp(),
                lastUpdated: FieldValue.serverTimestamp()
            });
        }

        res.status(200).send("Postback Received");
    } catch (err) {
        console.error("Quotex Webhook Error:", err.message);
        res.status(500).send("Internal Error");
    }
});

// 8. Payment receive endpoint (chobi thakuk ba na thakuk bot-e ashbe)
app.post('/submit-payment', upload.single('photo'), async (req, res) => {
    try {
        const { userId, email, txId, plan, method } = req.body;
        const photoFile = req.file;

        console.log(`[Payment Received] User: ${email}, TxID: ${txId}, Plan: ${plan}`);

        const captionText = 
`🔔 <b>নতুন VIP সাবস্ক্রিপশন পেমেন্ট এসেছে!</b>

👤 <b>ইউজার ইমেইল:</b> <code>${email}</code>
🆔 <b>User ID:</b> <code>${userId}</code>
📦 <b>নির্বাচিত প্ল্যান:</b> ${plan}
💳 <b>পেমেন্ট মেথড:</b> ${method}
🧾 <b>TxID / Hash:</b> <code>${txId}</code>

<i>অ্যাকশন নিতে নিচের যেকোনো বাটনে চাপ দিন:</i>`;

        const inlineKeyboard = {
            inline_keyboard: [
                [
                    { text: "✅ 7 Days VIP", callback_data: `approve_7_${email}` },
                    { text: "👑 Lifetime VIP", callback_data: `approve_life_${email}` }
                ],
                [
                    { text: "⚙️ Custom Days", callback_data: `custom_${email}` },
                    { text: "❌ Reject", callback_data: `reject_${email}` }
                ]
            ]
        };

        if (photoFile && photoFile.buffer) {
            await sendTelegramPhoto(
                adminChatId,
                photoFile.buffer,
                photoFile.originalname || 'payment_proof.jpg',
                photoFile.mimetype || 'image/jpeg',
                captionText,
                inlineKeyboard
            );
        } else {
            await sendTelegramMessage(adminChatId, captionText, inlineKeyboard);
        }

        res.status(200).json({ success: true, message: "Payment notification sent to Telegram" });
    } catch (err) {
        console.error("Submit Payment Route Error:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 9. Telegram polling loop (button click o command handler)
let lastUpdateId = 0;
async function processUpdate(update) {
    try {
        // Inline button click handling
        if (update.callback_query) {
            const query = update.callback_query;
            const data = query.data;
            const chatId = query.message.chat.id;
            const messageId = query.message.message_id;

            if (data.startsWith('approve_')) {
                const parts = data.split('_');
                const type = parts[1]; // '7' or 'life'
                const targetEmail = parts.slice(2).join('_');

                const userSnap = await db.collection('users').where('email', '==', targetEmail).limit(1).get();
                if (userSnap.empty) {
                    await sendTelegramMessage(chatId, `❌ ইউজার পাওয়া যায়নি: ${targetEmail}`);
                    return;
                }

                const userDoc = userSnap.docs[0];
                let updatePayload = { vipStatus: true, isBanned: false };
                let durationMsg = "";

                if (type === '7') {
                    const expiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
                    updatePayload.vipExpiresAt = expiry.toISOString();
                    durationMsg = "৭ দিনের VIP অ্যাক্সেস";
                } else if (type === 'life') {
                    updatePayload.vipExpiresAt = null;
                    durationMsg = "লাইফটাইম (Lifetime) VIP অ্যাক্সেস";
                }

                await userDoc.ref.update(updatePayload);

                const paySnap = await db.collection('payments').where('email', '==', targetEmail).where('status', '==', 'pending').get();
                paySnap.forEach(pDoc => pDoc.ref.update({ status: 'approved' }));

                // Shob data o chobi thakbe kintu button muche jabe
                await removeInlineKeyboard(chatId, messageId);

                await sendTelegramMessage(chatId, `✅ <b>সফল!</b>\nইউজার <code>${targetEmail}</code>-কে <b>${durationMsg}</b> সক্রিয় করে দেওয়া হয়েছে।`);
                await answerCallbackQuery(query.id, "Approved Successfully!");

            } else if (data.startsWith('custom_')) {
                const targetEmail = data.replace('custom_', '');
                const msg = `⚙️ <b>কাস্টম দিন দিতে নিচের কমান্ডটি কপি করে দিন বসিয়ে পাঠান:</b>\n\n<code>/approve ${targetEmail} 15</code>\n\n<i>(১৫-এর জায়গায় যত দিন খুশি সংখ্যা লিখতে পারেন)</i>`;
                await sendTelegramMessage(chatId, msg);
                await answerCallbackQuery(query.id, "কমান্ড ফরম্যাট পাঠানো হয়েছে");

            } else if (data.startsWith('reject_')) {
                const targetEmail = data.replace('reject_', '');
                const paySnap = await db.collection('payments').where('email', '==', targetEmail).where('status', '==', 'pending').get();
                paySnap.forEach(pDoc => pDoc.ref.update({ status: 'rejected' }));

                // Reject korleo button muche jabe
                await removeInlineKeyboard(chatId, messageId);

                await sendTelegramMessage(chatId, `❌ ইউজার <code>${targetEmail}</code>-এর পেমেন্ট রিজেক্ট করা হয়েছে।`);
                await answerCallbackQuery(query.id, "Rejected!");
            }
        }

        // Admin command handling (/start, /approve, /expire, /ban, /unban, /check, /stats)
        if (update.message && update.message.text) {
            const msg = update.message;
            const text = msg.text.trim();
            const chatId = msg.chat.id;

            if (String(chatId) !== String(adminChatId)) return;

            if (text === '/start') {
                const welcome = 
`👋 <b>JH Trading VIP Admin Bot চালু আছে!</b>

📌 <b>কমান্ড তালিকা:</b>
• <code>/approve &lt;email&gt; &lt;days&gt;</code> - নির্দিষ্ট দিন VIP দিন (উদা: <code>/approve user@gmail.com 15</code>)
• <code>/expire &lt;email&gt;</code> - ইউজারের VIP মেয়াদ শেষ বা বাতিল করুন (পুনরায় পেমেন্ট/UID লাগবে)
• <code>/check &lt;email&gt;</code> - প্রোফাইল, VIP মেয়াদ ও UID তথ্য দেখুন
• <code>/ban &lt;email&gt;</code> - ইউজার ব্যান করুন
• <code>/unban &lt;email&gt;</code> - ইউজার আনব্যান করুন
• <code>/stats</code> - মোট ইউজার ও VIP সংখ্যা দেখুন

🔔 সাইটে পেমেন্ট সাবমিট করলে স্ক্রিনশট ও বাটনসহ রিয়েল-টাইম নোটিফিকেশন আসবে।`;
                await sendTelegramMessage(chatId, welcome);
            } else if (text.startsWith('/approve ')) {
                const parts = text.split(' ');
                if (parts.length >= 3) {
                    const email = parts[1].trim();
                    const days = parseInt(parts[2]);
                    const snap = await db.collection('users').where('email', '==', email).limit(1).get();
                    if (snap.empty) {
                        await sendTelegramMessage(chatId, "❌ ইউজার পাওয়া যায়নি।");
                    } else {
                        const expiry = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
                        await snap.docs[0].ref.update({
                            vipStatus: true,
                            vipExpiresAt: expiry.toISOString(),
                            isBanned: false
                        });

                        const paySnap = await db.collection('payments').where('email', '==', email).where('status', '==', 'pending').get();
                        paySnap.forEach(pDoc => pDoc.ref.update({ status: 'approved' }));

                        await sendTelegramMessage(chatId, `✅ <code>${email}</code>-কে সফলভাবে <b>${days} দিনের VIP অ্যাক্সেস</b> দেওয়া হয়েছে।`);
                    }
                }
            } else if (text.startsWith('/expire ')) {
                const email = text.replace('/expire ', '').trim();
                const snap = await db.collection('users').where('email', '==', email).limit(1).get();
                if (snap.empty) {
                    await sendTelegramMessage(chatId, "❌ ইউজার পাওয়া যায়নি।");
                } else {
                    const userDoc = snap.docs[0];
                    const userData = userDoc.data();

                    if (userData.quotexUID) {
                        try {
                            await db.collection('quotex_traders').doc(String(userData.quotexUID)).delete();
                        } catch (err) {}
                    }

                    await userDoc.ref.update({
                        vipStatus: false,
                        vipExpiresAt: null,
                        quotexUID: null
                    });

                    await sendTelegramMessage(chatId, `⚠️ <b>VIP বাতিল করা হয়েছে:</b>\nইউজার <code>${email}</code>-এর VIP মেয়াদ এক্সপায়ার করা হয়েছে এবং কোটেক্স বাইন্ডিং রিসেট করা হয়েছে। তাকে সাইটে পুনরায় ডিপোজিট বা পেমেন্ট করতে হবে।`);
                }
            } else if (text.startsWith('/check ')) {
                const email = text.replace('/check ', '').trim();
                const snap = await db.collection('users').where('email', '==', email).limit(1).get();
                if (snap.empty) {
                    await sendTelegramMessage(chatId, "❌ কোনো ইউজার পাওয়া যায়নি।");
                } else {
                    const u = snap.docs[0].data();
                    const info = 
`📋 <b>ইউজার প্রোফাইল:</b>
• নাম: ${u.name || 'N/A'}
• ইমেইল: <code>${u.email}</code>
• টেলিগ্রাম: ${u.telegram || 'N/A'}
• Quotex UID: <code>${u.quotexUID || 'যুক্ত নেই'}</code>
• VIP স্ট্যাটাস: ${u.vipStatus ? 'ACTIVE 🟢' : 'INACTIVE 🔴'}
• VIP মেয়াদ: ${u.vipExpiresAt ? new Date(u.vipExpiresAt).toLocaleString() : (u.vipStatus ? 'LIFETIME' : 'N/A')}
• ব্যান স্ট্যাটাস: ${u.isBanned ? 'BANNED 🚫' : 'ACTIVE'}`;
                    await sendTelegramMessage(chatId, info);
                }
            } else if (text.startsWith('/ban ')) {
                const email = text.replace('/ban ', '').trim();
                const snap = await db.collection('users').where('email', '==', email).limit(1).get();
                if (snap.empty) {
                    await sendTelegramMessage(chatId, "❌ ইউজার পাওয়া যায়নি।");
                } else {
                    await snap.docs[0].ref.update({ isBanned: true, vipStatus: false });
                    await sendTelegramMessage(chatId, `🚫 ইউজার ব্যান করা হয়েছে:\n<code>${email}</code>`);
                }
            } else if (text.startsWith('/unban ')) {
                const email = text.replace('/unban ', '').trim();
                const snap = await db.collection('users').where('email', '==', email).limit(1).get();
                if (snap.empty) {
                    await sendTelegramMessage(chatId, "❌ ইউজার পাওয়া যায়নি।");
                } else {
                    await snap.docs[0].ref.update({ isBanned: false });
                    await sendTelegramMessage(chatId, `✅ ইউজার আনব্যান করা হয়েছে:\n<code>${email}</code>`);
                }
            } else if (text === '/stats') {
                const allUsers = await db.collection('users').get();
                const vipUsers = await db.collection('users').where('vipStatus', '==', true).get();
                const quotexTraders = await db.collection('quotex_traders').get();
                const statsMsg = 
`📊 <b>JH Trading Zone পরিসংখ্যান:</b>
• মোট রেজিস্টার্ড ইউজার: <b>${allUsers.size}</b> জন
• সক্রিয় VIP মেম্বার: <b>${vipUsers.size}</b> জন
• ভেরিফাইড কোটেক্স ট্রেডার: <b>${quotexTraders.size}</b> জন`;
                await sendTelegramMessage(chatId, statsMsg);
            }
        }
    } catch (err) {
        console.error("processUpdate Error:", err.message);
    }
}

async function startPolling() {
    if (!token) return;
    console.log("Telegram REST Engine Running Smoothly...");
    while (true) {
        try {
            const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates?offset=${lastUpdateId}&timeout=25`);
            const data = await res.json();
            if (data && data.ok && Array.isArray(data.result)) {
                for (const update of data.result) {
                    lastUpdateId = update.update_id + 1;
                    await processUpdate(update);
                }
            } else if (!data.ok) {
                console.warn("Telegram Notice:", data.description);
                await new Promise(r => setTimeout(r, 4000));
            }
        } catch (err) {
            await new Promise(r => setTimeout(r, 3000));
        }
    }
}

// 10. Port listen & polling start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Backend Server running on port ${PORT}`);
    startPolling();
});
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const TelegramBot = require('node-telegram-bot-api');
const admin = require('firebase-admin');

// ১. এক্সপ্রেস অ্যাপ ইনিশিয়ালাইজেশন
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ২. Multer মেমোরি স্টোরেজ সেটআপ (ছবি ফায়ারবেসে জমা না হয়ে মেমোরিতে থাকবে)
const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 } // সর্বোচ্চ ১০ মেগাবাইট ফাইল
});

// ৩. ফায়ারবেস অ্যাডমিন SDK সেটআপ
let serviceAccount;
try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    } else {
        serviceAccount = require('./serviceAccountKey.json');
    }
    
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log("Firebase Admin SDK Connected Successfully.");
} catch (error) {
    console.error("Firebase Admin SDK Init Error:", error.message);
}

const db = admin.firestore();

// ৪. টেলিগ্রাম বট ইনিশিয়ালাইজেশন
const token = process.env.TELEGRAM_BOT_TOKEN;
const adminChatId = process.env.ADMIN_CHAT_ID;
const bot = new TelegramBot(token, { polling: true });

console.log("Telegram Bot Engine Started...");

// ৫. UptimeRobot মনিটরিং রুট (200 OK নিশ্চিত রাখতে)
app.get('/', (req, res) => {
    res.status(200).send('Server is running');
});

// ৬. Quotex Webhook Postback রিসিভার
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
                lastUpdated: admin.firestore.FieldValue.serverTimestamp()
            });
        } else {
            await traderRef.set({
                traderId: traderIdStr,
                isAffiliate: true,
                hasDeposit: hasBalance,
                totalDeposit: depositNum,
                registeredAt: admin.firestore.FieldValue.serverTimestamp(),
                lastUpdated: admin.firestore.FieldValue.serverTimestamp()
            });
        }

        res.status(200).send("Postback Received");
    } catch (err) {
        console.error("Quotex Webhook Error:", err.message);
        res.status(500).send("Internal Error");
    }
});

// ৭. পেমেন্ট ও স্ক্রিনশট রিসিভ এন্ডপয়েন্ট (টেলিগ্রামে সরাসরি ছবি পাঠানো)
app.post('/submit-payment', upload.single('photo'), async (req, res) => {
    try {
        const { userId, email, txId, plan, method } = req.body;
        const photoFile = req.file;

        console.log(`[Payment Received] User: ${email}, TxID: ${txId}, Plan: ${plan}`);

        // টেলিগ্রাম মেসেজের সুন্দর ক্যাপশন প্রস্তুত
        const captionText = 
`🔔 <b>নতুন VIP সাবস্ক্রিপশন পেমেন্ট এসেছে!</b>

👤 <b>ইউজার ইমেইল:</b> <code>${email}</code>
🆔 <b>User ID:</b> <code>${userId}</code>
📦 <b>নির্বাচিত প্ল্যান:</b> ${plan}
💳 <b>পেমেন্ট মেথড:</b> ${method}
🧾 <b>TxID / Hash:</b> <code>${txId}</code>

<i>অ্যাকশন নিতে নিচের যেকোনো বাটনে চাপ দিন:</i>`;

        // টেলিগ্রাম ইনলাইন অ্যাকশন বাটন
        const inlineKeyboard = {
            inline_keyboard: [
                [
                    { text: "✅ 7 Days VIP", callback_data: `approve_7_${email}` },
                    { text: "⭐ 30 Days VIP", callback_data: `approve_30_${email}` }
                ],
                [
                    { text: "👑 Lifetime VIP", callback_data: `approve_life_${email}` },
                    { text: "❌ Reject", callback_data: `reject_${email}` }
                ]
            ]
        };

        // যদি স্ক্রিনশট ফাইল থাকে, তবে টেলিগ্রাম sendPhoto API দিয়ে সরাসরি ফটো পাঠানো
        if (photoFile && photoFile.buffer) {
            await bot.sendPhoto(adminChatId, photoFile.buffer, {
                caption: captionText,
                parse_mode: 'HTML',
                reply_markup: inlineKeyboard
            }, {
                filename: photoFile.originalname || 'payment_proof.jpg',
                contentType: photoFile.mimetype || 'image/jpeg'
            });
        } else {
            // ছবি ছাড়া সাবমিট হলে সাধারণ টেক্সট পাঠানো
            await bot.sendMessage(adminChatId, captionText, {
                parse_mode: 'HTML',
                reply_markup: inlineKeyboard
            });
        }

        res.status(200).json({ success: true, message: "Payment notification sent to Telegram" });
    } catch (err) {
        console.error("Submit Payment Route Error:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ৮. টেলিগ্রাম বট বাটন অ্যাকশন হ্যান্ডলার (Approve / Reject)
bot.on('callback_query', async (query) => {
    const data = query.data;
    const msgId = query.message.message_id;
    const chatId = query.message.chat.id;

    try {
        if (data.startsWith('approve_')) {
            const parts = data.split('_');
            const type = parts[1]; // '7', '30', or 'life'
            const targetEmail = parts.slice(2).join('_');

            // ইউজার খোঁজা
            const userSnap = await db.collection('users').where('email', '==', targetEmail).limit(1).get();
            if (userSnap.empty) {
                return bot.sendMessage(chatId, `❌ ইউজার পাওয়া যায়নি: ${targetEmail}`);
            }

            const userDoc = userSnap.docs[0];
            let updatePayload = {
                vipStatus: true,
                isBanned: false
            };

            let durationMsg = "";
            if (type === '7') {
                const expiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
                updatePayload.vipExpiresAt = expiry.toISOString();
                durationMsg = "৭ দিনের VIP অ্যাক্সেস";
            } else if (type === '30') {
                const expiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
                updatePayload.vipExpiresAt = expiry.toISOString();
                durationMsg = "৩০ দিনের VIP অ্যাক্সেস";
            } else if (type === 'life') {
                updatePayload.vipExpiresAt = null;
                durationMsg = "লাইফটাইম (Lifetime) VIP অ্যাক্সেস";
            }

            await userDoc.ref.update(updatePayload);

            // পেমেন্ট কালেকশনের স্ট্যাটাস approved করা
            const paySnap = await db.collection('payments').where('email', '==', targetEmail).where('status', '==', 'pending').get();
            paySnap.forEach(pDoc => pDoc.ref.update({ status: 'approved' }));

            await bot.sendMessage(chatId, `✅ <b>সফল!</b>\nইউজার <code>${targetEmail}</code>-কে <b>${durationMsg}</b> দেওয়া হয়েছে।`, { parse_mode: 'HTML' });
            await bot.answerCallbackQuery(query.id, { text: "Approved Successfully!" });

        } else if (data.startsWith('reject_')) {
            const targetEmail = data.replace('reject_', '');
            
            const paySnap = await db.collection('payments').where('email', '==', targetEmail).where('status', '==', 'pending').get();
            paySnap.forEach(pDoc => pDoc.ref.update({ status: 'rejected' }));

            await bot.sendMessage(chatId, `❌ ইউজার <code>${targetEmail}</code>-এর পেমেন্ট রিজেক্ট করা হয়েছে।`, { parse_mode: 'HTML' });
            await bot.answerCallbackQuery(query.id, { text: "Rejected!" });
        }
    } catch (e) {
        console.error("Callback Query Error:", e.message);
        bot.sendMessage(chatId, `ত্রুটি: ${e.message}`);
    }
});

// ৯. অ্যাডমিন কমান্ড তালিকা (/start, /approve, /ban, /unban, /check, /stats)
bot.onText(/\/start/, (msg) => {
    if (String(msg.chat.id) !== String(adminChatId)) return;
    const welcome = 
`👋 <b>JH Trading VIP Admin Bot চালু আছে!</b>

📌 <b>কমান্ড তালিকা:</b>
• <code>/check &lt;email&gt;</code> - ইউজারের প্রোফাইল ও ডিপোজিট স্ট্যাটাস দেখুন
• <code>/approve &lt;email&gt; &lt;days&gt;</code> - সরাসরি VIP মেয়াদ দিন (উদা: /approve user@gmail.com 30)
• <code>/ban &lt;email&gt;</code> - ইউজার ব্যান করুন
• <code>/unban &lt;email&gt;</code> - ইউজার আনব্যান করুন
• <code>/stats</code> - মোট ইউজার ও VIP সংখ্যা দেখুন

🔔 সাইটে পেমেন্ট সাবমিট করলে স্ক্রিনশট ও বাটনসহ রিয়েল-টাইম নোটিফিকেশন আসবে।`;
    bot.sendMessage(msg.chat.id, welcome, { parse_mode: 'HTML' });
});

bot.onText(/\/check (.+)/, async (msg, match) => {
    if (String(msg.chat.id) !== String(adminChatId)) return;
    const email = match[1].trim();
    try {
        const snap = await db.collection('users').where('email', '==', email).limit(1).get();
        if (snap.empty) return bot.sendMessage(msg.chat.id, "❌ কোনো ইউজার পাওয়া যায়নি।");

        const u = snap.docs[0].data();
        const info = 
`📋 <b>ইউজার প্রোফাইল:</b>
• নাম: ${u.name || 'N/A'}
• ইমেইল: <code>${u.email}</code>
• টেলিগ্রাম: ${u.telegram || 'N/A'}
• Quotex UID: <code>${u.quotexUID || 'যুক্ত নেই'}</code>
• VIP স্ট্যাটাস: ${u.vipStatus ? 'ACTIVE 🟢' : 'INACTIVE 🔴'}
• VIP মেয়াদ: ${u.vipExpiresAt ? new Date(u.vipExpiresAt).toLocaleString() : 'LIFETIME'}
• ব্যান স্ট্যাটাস: ${u.isBanned ? 'BANNED 🚫' : 'ACTIVE'}`;
        bot.sendMessage(msg.chat.id, info, { parse_mode: 'HTML' });
    } catch (err) {
        bot.sendMessage(msg.chat.id, `Error: ${err.message}`);
    }
});

bot.onText(/\/approve (\S+) (\d+)/, async (msg, match) => {
    if (String(msg.chat.id) !== String(adminChatId)) return;
    const email = match[1].trim();
    const days = parseInt(match[2]);
    try {
        const snap = await db.collection('users').where('email', '==', email).limit(1).get();
        if (snap.empty) return bot.sendMessage(msg.chat.id, "❌ ইউজার পাওয়া যায়নি।");

        const expiry = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
        await snap.docs[0].ref.update({
            vipStatus: true,
            vipExpiresAt: expiry.toISOString(),
            isBanned: false
        });

        bot.sendMessage(msg.chat.id, `✅ <code>${email}</code>-কে ${days} দিনের জন্য VIP অ্যাক্সেস দেওয়া হয়েছে।`, { parse_mode: 'HTML' });
    } catch (err) {
        bot.sendMessage(msg.chat.id, `Error: ${err.message}`);
    }
});

bot.onText(/\/ban (.+)/, async (msg, match) => {
    if (String(msg.chat.id) !== String(adminChatId)) return;
    const email = match[1].trim();
    try {
        const snap = await db.collection('users').where('email', '==', email).limit(1).get();
        if (snap.empty) return bot.sendMessage(msg.chat.id, "❌ ইউজার পাওয়া যায়নি।");

        await snap.docs[0].ref.update({ isBanned: true, vipStatus: false });
        bot.sendMessage(msg.chat.id, `🚫 ইউজার ব্যান করা হয়েছে:\n<code>${email}</code>`, { parse_mode: 'HTML' });
    } catch (err) {
        bot.sendMessage(msg.chat.id, `Error: ${err.message}`);
    }
});

bot.onText(/\/unban (.+)/, async (msg, match) => {
    if (String(msg.chat.id) !== String(adminChatId)) return;
    const email = match[1].trim();
    try {
        const snap = await db.collection('users').where('email', '==', email).limit(1).get();
        if (snap.empty) return bot.sendMessage(msg.chat.id, "❌ ইউজার পাওয়া যায়নি।");

        await snap.docs[0].ref.update({ isBanned: false });
        bot.sendMessage(msg.chat.id, `✅ ইউজার আনব্যান করা হয়েছে:\n<code>${email}</code>`, { parse_mode: 'HTML' });
    } catch (err) {
        bot.sendMessage(msg.chat.id, `Error: ${err.message}`);
    }
});

bot.onText(/\/stats/, async (msg) => {
    if (String(msg.chat.id) !== String(adminChatId)) return;
    try {
        const allUsers = await db.collection('users').get();
        const vipUsers = await db.collection('users').where('vipStatus', '==', true).get();
        const quotexTraders = await db.collection('quotex_traders').get();

        const statsMsg = 
`📊 <b>JH Trading Zone পরিসংখ্যান:</b>
• মোট রেজিস্টার্ড ইউজার: <b>${allUsers.size}</b> জন
• সক্রিয় VIP মেম্বার: <b>${vipUsers.size}</b> জন
• ভেরিফাইড কোটেক্স ট্রেডার: <b>${quotexTraders.size}</b> জন`;
        bot.sendMessage(msg.chat.id, statsMsg, { parse_mode: 'HTML' });
    } catch (err) {
        bot.sendMessage(msg.chat.id, `Error: ${err.message}`);
    }
});

// ১০. সার্ভার পোর্ট লিসেন
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Backend Server running on port ${PORT}`);
});
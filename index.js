// index.js
require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const admin = require('firebase-admin');
const fs = require('fs');

const BOT_TOKEN = process.env.BOT_TOKEN;
const SERVICE_ACCOUNT_PATH = process.env.SERVICE_ACCOUNT_PATH || './serviceAccountKey.json';

if (!BOT_TOKEN) {
  console.error('BOT_TOKEN topilmadi');
  process.exit(1);
}
if (!fs.existsSync(SERVICE_ACCOUNT_PATH)) {
  console.error('Service account JSON topilmadi:', SERVICE_ACCOUNT_PATH);
  process.exit(1);
}

const serviceAccount = require(SERVICE_ACCOUNT_PATH);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.DATABASE_URL || 'https://uncenter-16f01-default-rtdb.asia-southeast1.firebasedatabase.app'
});

const db = admin.database();
const bot = new Telegraf(BOT_TOKEN);

const sessions = new Map();
function getSession(ctx) {
  const id = ctx.from.id;
  if (!sessions.has(id))
    sessions.set(id, {
      cart: [],
      awaitingQuantity: false,
      selectedProductId: null,
    });
  return sessions.get(id);
}

// Start command
bot.start(async (ctx) => {
  const chatId = ctx.chat.id;
  const userRef = db.ref(`users/${chatId}`);

  try {
    const snapshot = await userRef.once('value');
    const userData = snapshot.val();

    if (userData && userData.phone_number) {
      // 🔹 Agar raqam allaqachon bor bo‘lsa — qayta so‘ramaymiz
      await ctx.reply(`👋 Salom, ${userData.first_name || 'foydalanuvchi'}!
Sizning raqamingiz: ${userData.phone_number}
Buyurtma berishga tayyormiz ✅`);
    } else {
      // 🔹 Raqam hali olinmagan — so‘raymiz
      await ctx.reply(
        "📱 Iltimos, telefon raqamingizni ulashing:",
        Markup.keyboard([
          [Markup.button.contactRequest('📲 Raqamni yuborish')]
        ])
          .oneTime()
          .resize()
      );
    }
  } catch (err) {
    console.error('Startda xatolik:', err);
    ctx.reply('Xatolik yuz berdi, keyinroq urinib ko‘ring.');
  }
});

bot.on('contact', async (ctx) => {
  const chatId = ctx.chat.id;
  const contact = ctx.message.contact;

  if (!contact || !contact.phone_number) {
    return ctx.reply('❌ Raqam topilmadi. Iltimos, tugma orqali yuboring.');
  }

  const userRef = db.ref(`users/${chatId}`);

  await userRef.set({
    first_name: ctx.from.first_name,
    username: ctx.from.username || '',
    phone_number: contact.phone_number,
  });

  await ctx.reply(
    `✅ Raqamingiz saqlandi: ${contact.phone_number}\n\nEndi buyurtma berishingiz yoki skladni ko‘rishingiz mumkin 👇`,
    Markup.keyboard([
      ['🛒 Buyurtma berish', '📦 Skladni ko‘rish']
    ]).resize()
  );
});



// Skladni ko‘rish
bot.hears('📦 Skladni ko‘rish', async (ctx) => {
  const snap = await db.ref('products').once('value');
  const data = snap.val();
  if (!data) return ctx.reply('Skladda mahsulotlar yo‘q.');

  let msg = '📦 *Skladdagi mahsulotlar:*\n\n';
  for (const [id, p] of Object.entries(data)) {
    msg += `• ${p.name} (${p.type}) — ${p.quantity} dona — ${p.price.toLocaleString()} so'm\n`;
  }
  return ctx.replyWithMarkdown(msg);
});

// Buyurtma berish
bot.hears('🛒 Buyurtma berish', async (ctx) => {
  const snap = await db.ref('products').once('value');
  const data = snap.val();
  if (!data) return ctx.reply('Skladda mahsulotlar yo‘q.');

  const types = [...new Set(Object.values(data).map((p) => p.type))];
  const buttons = types.map((t) => Markup.button.callback(t, `type_${t}`));
  ctx.reply('Kerakli turini tanlang:', Markup.inlineKeyboard(buttons, { columns: 2 }));
});

// Tur tanlandi
bot.action(/type_(.+)/, async (ctx) => {
  const type = ctx.match[1];
  await ctx.answerCbQuery();

  const snap = await db.ref('products').once('value');
  const data = snap.val() || {};
  const filtered = Object.entries(data)
    .filter(([id, p]) => p.type === type)
    .map(([id, p]) => ({ id, ...p }));

  const buttons = filtered.map((p) =>
    Markup.button.callback(`${p.name} (${p.quantity} dona) — ${p.price.toLocaleString()} so'm`, `product_${p.id}`)
  );
  buttons.push(Markup.button.callback('🔙 Orqaga', 'back_to_types'));

  ctx.reply(`*${type}* turidagi mahsulotlar:`, {
    parse_mode: 'Markdown',
  });
  await ctx.reply('Mahsulotni tanlang:', Markup.inlineKeyboard(buttons, { columns: 1 }));
});

bot.action('back_to_types', async (ctx) => {
  await ctx.answerCbQuery();
  const snap = await db.ref('products').once('value');
  const data = snap.val();
  const types = [...new Set(Object.values(data).map((p) => p.type))];
  const buttons = types.map((t) => Markup.button.callback(t, `type_${t}`));
  ctx.reply('Tur tanlang:', Markup.inlineKeyboard(buttons, { columns: 2 }));
});

// Mahsulot tanlandi
bot.action(/product_(.+)/, async (ctx) => {
  const id = ctx.match[1];
  await ctx.answerCbQuery();

  const snap = await db.ref(`products/${id}`).once('value');
  const p = snap.val();
  if (!p) return ctx.reply('Bu mahsulot topilmadi.');

  const s = getSession(ctx);
  s.awaitingQuantity = true;
  s.selectedProductId = id;

  ctx.replyWithMarkdown(`Siz *${p.name}* ni tanladingiz.\nMavjud: *${p.quantity} dona*\nIltimos, miqdorni kiriting:`);
});

// Miqdor kiritish
bot.on('text', async (ctx) => {
  const s = getSession(ctx);
  const text = ctx.message.text.trim();

  if (s.awaitingQuantity && s.selectedProductId) {
    if (!/^\d+$/.test(text)) return ctx.reply('Faqat raqam kiriting.');
    const qty = Number(text);

    const snap = await db.ref(`products/${s.selectedProductId}`).once('value');
    const p = snap.val();
    if (!p) return ctx.reply('Mahsulot topilmadi.');
    if (qty > p.quantity) return ctx.reply(`Afsus, omborda faqat ${p.quantity} dona bor.`);

    const total = qty * p.price;

    // Savatga qo'shish
    s.cart.push({
      id: s.selectedProductId,
      name: p.name,
      unitPrice: p.price,
      quantity: qty,
      total,
    });

    const overall = s.cart.reduce((a, b) => a + b.total, 0);
    s.awaitingQuantity = false;
    s.selectedProductId = null;

    // Yangi qo'shilgan hamda umumiy hisob
    let msg = `🟢 Mahsulot qo'shildi: ${p.name} — ${qty} dona.\n`;
    msg += `💰 Jami hozircha: ${overall.toLocaleString()} so'm\n\n`;
    msg += `Quyidagi tugmalardan birini tanlang:`;

    // Tugmalar: +yana, tasdiqlash, bekor qilish
    ctx.replyWithMarkdown(
      msg,
      Markup.inlineKeyboard([
        [Markup.button.callback('➕ Yana mahsulot qo‘shish', 'add_more')],
        [Markup.button.callback('✅ Buyurtmani tasdiqlash', 'finish_order')],
        [Markup.button.callback('❌ Bekor qilish', 'cancel_order')],
      ])
    );
  }
});

// +yana bosilganda turlarga qaytadi
bot.action('add_more', async (ctx) => {
  await ctx.answerCbQuery();
  const snap = await db.ref('products').once('value');
  const data = snap.val();
  const types = [...new Set(Object.values(data).map((p) => p.type))];
  const buttons = types.map((t) => Markup.button.callback(t, `type_${t}`));
  ctx.reply('Yana tur tanlang:', Markup.inlineKeyboard(buttons, { columns: 2 }));
});

// Tasdiqlash
bot.action('finish_order', async (ctx) => {
  await ctx.answerCbQuery();
  const s = getSession(ctx);
  const cart = s.cart;
  if (!cart.length) return ctx.reply('Savat bo‘sh.');

  let msg = '🧾 *Buyurtmangiz:*\n\n';
  cart.forEach((c, i) => {
    msg += `${i + 1}. ${c.name} — ${c.quantity} dona × ${c.unitPrice.toLocaleString()} = ${c.total.toLocaleString()} so'm\n`;
  });
  const total = cart.reduce((a, b) => a + b.total, 0);
  msg += `\n💰 *Umumiy summa:* ${total.toLocaleString()} so'm\n\nTasdiqlaysizmi?`;

  ctx.replyWithMarkdown(
    msg,
    Markup.inlineKeyboard([
      [Markup.button.callback('✅ Ha, to‘g‘ri', 'confirm_order')],
      [Markup.button.callback('❌ Yo‘q, bekor qilish', 'cancel_order')],
    ])
  );
});

// Buyurtmani bekor qilish
bot.action('cancel_order', async (ctx) => {
  await ctx.answerCbQuery();
  sessions.delete(ctx.from.id);
  ctx.reply('Buyurtma bekor qilindi.');
});

// Yakuniy tasdiqlash
// Yakuniy tasdiqlash
bot.action('confirm_order', async (ctx) => {
  await ctx.answerCbQuery();
  const s = getSession(ctx);
  const cart = s.cart;
  if (!cart.length) return ctx.reply('Savat bo‘sh.');

  try {
    // Tekshirish
    const productIds = cart.map((c) => c.id);
    const snaps = await Promise.all(productIds.map((id) => db.ref(`products/${id}`).once('value')));
    const shortages = [];
    for (let i = 0; i < snaps.length; i++) {
      const cur = snaps[i].val();
      const item = cart[i];
      if (!cur || item.quantity > cur.quantity) {
        shortages.push(item.name);
      }
    }

    if (shortages.length) {
      let txt = '⚠️ Quyidagi mahsulotlar yetarli emas:\n';
      shortages.forEach((n) => (txt += `• ${n}\n`));
      return ctx.reply(txt);
    }

    // Skladdan kamaytirish
    for (let c of cart) {
      await db.ref(`products/${c.id}`).transaction((p) => {
        if (p && p.quantity >= c.quantity) {
          p.quantity -= c.quantity;
        }
        return p;
      });
    }

    // ✅ Orders listga yozish (har bir mahsulot va umumiy summa bilan)
    const items = cart.map((p) => ({
      productId: p.id,
      name: p.name,
      price: p.unitPrice,
      quantity: p.quantity,
      total: p.total,
    }));
    const totalPrice = items.reduce((a, i) => a + i.total, 0);

    await db.ref('orders').push({
      buyerId: ctx.from.id,
      buyerName: ctx.from.first_name || '',
      buyerUsername: ctx.from.username || '',
      phoneNumber: (await db.ref(`users/${ctx.from.id}/phone_number`).once('value')).val() || '', 
      items,
      totalPrice,
      createdAt: new Date().toISOString(),
    });

    // Sessiyani tozalash
    sessions.delete(ctx.from.id);

    ctx.reply(
      `✅ Buyurtmangiz qabul qilindi! Inshaalloh tez orada yetkaziladi.\n\n💰 Umumiy summa: ${totalPrice.toLocaleString()} so'm`,
      Markup.keyboard([['🛒 Buyurtma berish', '📦 Skladni ko‘rish']]).resize()
    );
  } catch (err) {
    console.error(err);
    ctx.reply('Xatolik yuz berdi, keyinroq urinib ko‘ring.');
  }
});

// bot.action('confirm_order', async (ctx) => {
//   await ctx.answerCbQuery();
//   const s = getSession(ctx);
//   const cart = s.cart;
//   if (!cart.length) return ctx.reply('Savat bo‘sh.');

//   try {
//     // Tekshirish
//     const productIds = cart.map((c) => c.id);
//     const snaps = await Promise.all(productIds.map((id) => db.ref(`products/${id}`).once('value')));
//     const shortages = [];
//     for (let i = 0; i < snaps.length; i++) {
//       const cur = snaps[i].val();
//       const item = cart[i];
//       if (!cur || item.quantity > cur.quantity) {
//         shortages.push(item.name);
//       }
//     }

//     if (shortages.length) {
//       let txt = '⚠️ Quyidagi mahsulotlar yetarli emas:\n';
//       shortages.forEach((n) => (txt += `• ${n}\n`));
//       return ctx.reply(txt);
//     }

//     // Skladdan kamaytirish
//     for (let c of cart) {
//       await db.ref(`products/${c.id}`).transaction((p) => {
//         if (p && p.quantity >= c.quantity) {
//           p.quantity -= c.quantity;
//         }
//         return p;
//       });
//     }

//     // Orders listga yozish
//     const total = cart.reduce((a, b) => a + b.total, 0);
//     await db.ref('orders').push({
//       userId: ctx.from.id,
//       userName: ctx.from.first_name || '',
//       username: ctx.from.username || '',
//       items: cart,
//       total,
//       createdAt: new Date().toISOString(),
//     });

//     sessions.delete(ctx.from.id);
//     ctx.reply(
//       '✅ Buyurtmangiz qabul qilindi! Inshaalloh tez orada yetkaziladi.\n\nRahmat!',
//       Markup.keyboard([['🛒 Buyurtma berish', '📦 Skladni ko‘rish']]).resize()
//     );
//   } catch (err) {
//     console.error(err);
//     ctx.reply('Xatolik yuz berdi, keyinroq urinib ko‘ring.');
//   }
// });

bot.launch();
console.log('Bot ishlamoqda...');

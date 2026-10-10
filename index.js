// ========= تنظیمات اصلی =========
const TELEGRAM_API = "https://api.telegram.org/bot";
const RAILWAY_GRAPHQL = "https://backboard.railway.app/graphql/v2";
const NETHERLANDS_REGION = "europe-west4";

// ========= تابع ارسال پیام به تلگرام =========
async function sendMessage(token, chatId, text, keyboard = null, messageId = null) {
  const url = `${TELEGRAM_API}${token}/${messageId ? 'editMessageText' : 'sendMessage'}`;
  const body = {
    chat_id: chatId,
    text: text,
    parse_mode: "Markdown"
  };
  if (messageId) body.message_id = messageId;
  if (keyboard) body.reply_markup = { inline_keyboard: keyboard };
  
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return await resp.json();
}

async function answerCallback(token, callbackId, text = "", alert = false) {
  await fetch(`${TELEGRAM_API}${token}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackId, text, show_alert: alert })
  });
}

// ========= منوی اصلی =========
function getMainKeyboard(userId, hasToken, adminId) {
  const buttons = [];
  if (hasToken) {
    buttons.push([{ text: "🚀 ساخت پنل روی ریلوی", callback_data: "select_panel" }]);
    buttons.push([{ text: "🔄 تغییر توکن", callback_data: "set_token" }]);
  } else {
    buttons.push([{ text: "🔑 ثبت توکن ریلوی", callback_data: "set_token" }]);
  }
  buttons.push([{ text: " راهنما", callback_data: "help" }]);
  if (userId == adminId) {
    buttons.push([{ text: "⚙️ پنل مدیریت (ادمین)", callback_data: "admin_panel" }]);
  }
  return buttons;
}

// ========= دیتابیس D1 =========
async function getUser(db, userId) {
  const result = await db.prepare("SELECT * FROM users WHERE user_id = ?").bind(userId).first();
  return result;
}

async function saveToken(db, userId, token) {
  await db.prepare("INSERT OR REPLACE INTO users (user_id, railway_token) VALUES (?, ?)").bind(userId, token).run();
}

async function setState(db, userId, state, data = null) {
  await db.prepare("INSERT INTO users (user_id, state, state_data) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET state = ?, state_data = ?")
    .bind(userId, state, data, state, data).run();
}

async function clearState(db, userId) {
  await db.prepare("UPDATE users SET state = NULL, state_data = NULL WHERE user_id = ?").bind(userId).run();
}

async function getAllPanels(db) {
  const { results } = await db.prepare("SELECT * FROM panels").all();
  return results || [];
}

async function getPanelById(db, id) {
  return await db.prepare("SELECT * FROM panels WHERE id = ?").bind(id).first();
}

async function addPanel(db, name, repo) {
  await db.prepare("INSERT INTO panels (name, repo, default_user, default_pass) VALUES (?, ?, 'admin', 'admin')").bind(name, repo).run();
}

async function deletePanel(db, id) {
  await db.prepare("DELETE FROM panels WHERE id = ?").bind(id).run();
}

async function getTotalUsers(db) {
  const result = await db.prepare("SELECT COUNT(*) as count FROM users WHERE railway_token IS NOT NULL").first();
  return result.count;
}

// ========= Railway API =========
async function railwayGraphQL(token, query, variables = {}) {
  try {
    const resp = await fetch(RAILWAY_GRAPHQL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ query, variables })
    });
    const data = await resp.json();
    if (data.errors) return { error: data.errors[0].message };
    return { data: data.data };
  } catch (e) {
    return { error: e.message };
  }
}

async function validateToken(token) {
  const query = `query { me { email workspaces { id } } }`;
  const result = await railwayGraphQL(token, query);
  if (result.error) return { valid: false, error: result.error };
  return { valid: true, email: result.data.me.email, workspaces: result.data.me.workspaces };
}

async function deployPanel(token, repo) {
  const userInfo = await railwayGraphQL(token, `query { me { workspaces { id } } }`);
  if (userInfo.error) return { error: userInfo.error };
  const workspaceId = userInfo.data.me.workspaces[0]?.id;

  const projName = `panel-${Math.random().toString(36).substring(2, 6)}`;
  const projInput = { name: projName };
  if (workspaceId) projInput.workspaceId = workspaceId;

  const projQuery = `mutation projectCreate($input: ProjectCreateInput!) {
    projectCreate(input: $input) { id environments { edges { node { id } } } }
  }`;
  const projResult = await railwayGraphQL(token, projQuery, { input: projInput });
  if (projResult.error) return { error: projResult.error };
  
  const projectId = projResult.data.projectCreate.id;
  const envId = projResult.data.projectCreate.environments.edges[0].node.id;

  const serviceQuery = `mutation serviceCreate($input: ServiceCreateInput!) {
    serviceCreate(input: $input) { id }
  }`;
  const svcResult = await railwayGraphQL(token, serviceQuery, {
    input: { projectId, source: { repo } }
  });
  if (svcResult.error) return { error: svcResult.error };
  const serviceId = svcResult.data.serviceCreate.id;

  await railwayGraphQL(token, `mutation serviceInstanceUpdate($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) {
    serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input)
  }`, { serviceId, environmentId: envId, input: { region: NETHERLANDS_REGION } });

  await new Promise(r => setTimeout(r, 2000));

  await railwayGraphQL(token, `mutation serviceInstanceDeploy($serviceId: String!, $environmentId: String!) {
    serviceInstanceDeploy(serviceId: $serviceId, environmentId: $environmentId)
  }`, { serviceId, environmentId: envId });

  const domainResult = await railwayGraphQL(token, `mutation serviceDomainCreate($input: ServiceDomainCreateInput!) {
    serviceDomainCreate(input: $input) { domain }
  }`, { input: { environmentId: envId, serviceId } });

  const domain = domainResult.data?.serviceDomainCreate?.domain 
    ? `https://${domainResult.data.serviceDomainCreate.domain}` 
    : "در حال آماده‌سازی...";

  return { domain, user: "admin", pass: "admin" };
}

// ========= هندل آپدیت‌های تلگرام =========
async function handleUpdate(update, env) {
  const BOT_TOKEN = env.BOT_TOKEN;
  const ADMIN_ID = env.ADMIN_ID;
  const db = env.DB;

  // دستور متنی
  if (update.message) {
    const msg = update.message;
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    const text = msg.text || "";

    if (text === "/start") {
      await clearState(db, userId);
      const user = await getUser(db, userId);
      const hasToken = user && user.railway_token;
      const welcome = `سلام ${msg.from.first_name} عزیز! 🌹\nبه ربات هوشمند نصاب پنل‌های Railway خوش آمدید.\nلوکیشن تمامی سرورها: 🇳🇱 هلند (Amsterdam)`;
      await sendMessage(BOT_TOKEN, chatId, welcome, getMainKeyboard(userId, hasToken, ADMIN_ID));
      return;
    }

    // چک کردن state برای فرم‌های فعال
    const user = await getUser(db, userId);
    const state = user?.state;

    if (state === "waiting_token") {
      const result = await validateToken(text.trim());
      if (result.valid) {
        await saveToken(db, userId, text.trim());
        await clearState(db, userId);
        await sendMessage(BOT_TOKEN, chatId, `✅ **توکن تایید شد!**\nایمیل: \`${result.email}\``, getMainKeyboard(userId, true, ADMIN_ID));
      } else {
        await sendMessage(BOT_TOKEN, chatId, `❌ **خطا:** ${result.error}\nمجدداً توکن را بفرستید.`);
      }
      return;
    }

    if (state === "waiting_panel_name" && userId == ADMIN_ID) {
      await setState(db, userId, "waiting_panel_repo", text.trim());
      await sendMessage(BOT_TOKEN, chatId, "اکنون **آدرس ریپازیتوری گیت‌هاب** را بفرستید (مثلاً `x4gpanell/SuperJinX`):");
      return;
    }

    if (state === "waiting_panel_repo" && userId == ADMIN_ID) {
      let repo = text.trim();
      const match = repo.match(/github\.com\/([^\/]+\/[^\/\s]+)/);
      if (match) repo = match[1].replace(".git", "");
      
      await addPanel(db, user.state_data, repo);
      await clearState(db, userId);
      await sendMessage(BOT_TOKEN, chatId, `✅ **پنل جدید اضافه شد!**\n🏷 ${user.state_data}\n📦 \`${repo}\``, 
        [[{ text: "🔙 بازگشت به ادمین", callback_data: "admin_panel" }]]);
      return;
    }

    // بازیابی بک‌آپ از JSON
    if (state === "waiting_backup" && userId == ADMIN_ID) {
      try {
        const backup = JSON.parse(text);
        if (backup.panels) {
          await db.prepare("DELETE FROM panels").run();
          for (const p of backup.panels) {
            await db.prepare("INSERT INTO panels (name, repo, default_user, default_pass) VALUES (?, ?, ?, ?)")
              .bind(p.name, p.repo, p.default_user || 'admin', p.default_pass || 'admin').run();
          }
        }
        if (backup.users) {
          for (const u of backup.users) {
            await db.prepare("INSERT OR REPLACE INTO users (user_id, railway_token) VALUES (?, ?)")
              .bind(u.user_id, u.railway_token).run();
          }
        }
        await clearState(db, userId);
        await sendMessage(BOT_TOKEN, chatId, "✅ بک‌آپ با موفقیت بازیابی شد!", getMainKeyboard(userId, true, ADMIN_ID));
      } catch (e) {
        await sendMessage(BOT_TOKEN, chatId, `❌ فایل JSON نامعتبر است: ${e.message}`);
      }
      return;
    }
  }

  // کلیک روی دکمه‌ها
  if (update.callback_query) {
    const cb = update.callback_query;
    const userId = cb.from.id;
    const chatId = cb.message.chat.id;
    const messageId = cb.message.message_id;
    const data = cb.data;

    await answerCallback(BOT_TOKEN, cb.id);

    if (data === "set_token") {
      await setState(db, userId, "waiting_token");
      await sendMessage(BOT_TOKEN, chatId, "🔑 **توکن ریلوی خود را بفرستید:**\n(از بخش Account Settings > Tokens)", null, messageId);
      return;
    }

    if (data === "help") {
      const user = await getUser(db, userId);
      await sendMessage(BOT_TOKEN, chatId, "📖 **راهنما:**\nاین ربات پنل‌های فیلترشکن را روی اکانت ریلوی شما با لوکیشن 🇳🇱 هلند می‌سازد.", 
        getMainKeyboard(userId, !!user?.railway_token, ADMIN_ID), messageId);
      return;
    }

    if (data === "back_home") {
      const user = await getUser(db, userId);
      await sendMessage(BOT_TOKEN, chatId, "منوی اصلی:", getMainKeyboard(userId, !!user?.railway_token, ADMIN_ID), messageId);
      return;
    }

    if (data === "select_panel") {
      const panels = await getAllPanels(db);
      const buttons = panels.map(p => [{ text: p.name, callback_data: `deploy_${p.id}` }]);
      buttons.push([{ text: "🔙 بازگشت", callback_data: "back_home" }]);
      await sendMessage(BOT_TOKEN, chatId, "پنل مورد نظر برای نصب را انتخاب کنید:", buttons, messageId);
      return;
    }

    if (data.startsWith("deploy_")) {
      const panelId = parseInt(data.split("_")[1]);
      const panel = await getPanelById(db, panelId);
      const user = await getUser(db, userId);
      if (!user?.railway_token) {
        await answerCallback(BOT_TOKEN, cb.id, "ابتدا توکن ثبت کنید!", true);
        return;
      }
      
      await sendMessage(BOT_TOKEN, chatId, `⏳ در حال ساخت **${panel.name}** روی سرور هلند...`, null, messageId);
      const result = await deployPanel(user.railway_token, panel.repo);
      
      if (result.error) {
        await sendMessage(BOT_TOKEN, chatId, `❌ خطا: \`${result.error}\``, getMainKeyboard(userId, true, ADMIN_ID), messageId);
      } else {
        const success = `🎉 **پنل ${panel.name} ساخته شد!**\n\n🌐 ${result.domain}\n👤 \`${result.user}\`\n🔑 \`${result.pass}\`\n🇳🇱 هلند`;
        await sendMessage(BOT_TOKEN, chatId, success, getMainKeyboard(userId, true, ADMIN_ID), messageId);
      }
      return;
    }

    // ======== بخش ادمین ========
    if (data === "admin_panel") {
      if (userId != ADMIN_ID) {
        await answerCallback(BOT_TOKEN, cb.id, "دسترسی ندارید!", true);
        return;
      }
      await clearState(db, userId);
      const kb = [
        [{ text: "➕ افزودن پنل", callback_data: "adm_add" }, { text: "🗑 حذف پنل", callback_data: "adm_del" }],
        [{ text: "📥 گرفتن بک‌آپ", callback_data: "adm_backup" }, { text: "📤 بازیابی بک‌آپ", callback_data: "adm_restore" }],
        [{ text: "📊 آمار", callback_data: "adm_stats" }],
        [{ text: "🔙 بازگشت", callback_data: "back_home" }]
      ];
      await sendMessage(BOT_TOKEN, chatId, "👑 **پنل مدیریت:**", kb, messageId);
      return;
    }

    if (data === "adm_add" && userId == ADMIN_ID) {
      await setState(db, userId, "waiting_panel_name");
      await sendMessage(BOT_TOKEN, chatId, "**نام نمایشی پنل** را بفرستید:", null, messageId);
      return;
    }

    if (data === "adm_del" && userId == ADMIN_ID) {
      const panels = await getAllPanels(db);
      const buttons = panels.map(p => [{ text: `❌ ${p.name}`, callback_data: `delp_${p.id}` }]);
      buttons.push([{ text: "🔙 بازگشت", callback_data: "admin_panel" }]);
      await sendMessage(BOT_TOKEN, chatId, "برای حذف کلیک کنید:", buttons, messageId);
      return;
    }

    if (data.startsWith("delp_") && userId == ADMIN_ID) {
      const pid = parseInt(data.split("_")[1]);
      await deletePanel(db, pid);
      await answerCallback(BOT_TOKEN, cb.id, "حذف شد!", true);
      const panels = await getAllPanels(db);
      const buttons = panels.map(p => [{ text: `❌ ${p.name}`, callback_data: `delp_${p.id}` }]);
      buttons.push([{ text: "🔙 بازگشت", callback_data: "admin_panel" }]);
      await sendMessage(BOT_TOKEN, chatId, "برای حذف کلیک کنید:", buttons, messageId);
      return;
    }

    if (data === "adm_stats" && userId == ADMIN_ID) {
      const total = await getTotalUsers(db);
      const panels = await getAllPanels(db);
      await answerCallback(BOT_TOKEN, cb.id, `👥 کاربران: ${total}\n📦 پنل‌ها: ${panels.length}`, true);
      return;
    }

    if (data === "adm_backup" && userId == ADMIN_ID) {
      const { results: users } = await db.prepare("SELECT user_id, railway_token FROM users WHERE railway_token IS NOT NULL").all();
      const panels = await getAllPanels(db);
      const backup = { users, panels };
      const json = JSON.stringify(backup, null, 2);
      await sendMessage(BOT_TOKEN, chatId, `📦 **فایل بک‌آپ (کپی و ذخیره کنید):**\n\n\`\`\`json\n${json}\n\`\`\``, 
        [[{ text: "🔙 بازگشت", callback_data: "admin_panel" }]]);
      return;
    }

    if (data === "adm_restore" && userId == ADMIN_ID) {
      await setState(db, userId, "waiting_backup");
      await sendMessage(BOT_TOKEN, chatId, "📤 **محتوای کامل JSON بک‌آپ قبلی را Paste و ارسال کنید:**", null, messageId);
      return;
    }
  }
}

// ========= Entry Point ورکر =========
export default {
  async fetch(request, env) {
    if (request.method === "POST") {
      try {
        const update = await request.json();
        await handleUpdate(update, env);
        return new Response("OK");
      } catch (e) {
        return new Response(`Error: ${e.message}`, { status: 500 });
      }
    }
    return new Response("Bot is running!");
  }
};

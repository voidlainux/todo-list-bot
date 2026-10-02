import htmlContent from "./index.html";

export default {
  async fetch(request, env = {}, ctx) {
    if (request.method === "OPTIONS") {
      return handleCors();
    }

    const token = getBotToken(env);
    if (!token) {
      return jsonResponse(
        { ok: false, error: "Configuration Error: BOT_TOKEN is missing" },
        500,
      );
    }

    const url = new URL(request.url);

    if (url.pathname === "/setup" && request.method === "GET") {
      const secret = (
        env.WEBHOOK_SECRET ||
        env.TELEGRAM_WEBHOOK_SECRET ||
        ""
      ).trim();
      const setupKey = url.searchParams.get("secret");
      if (!secret || setupKey !== secret) {
        return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
      }
      const webhookUrl = `https://${url.hostname}/webhook`;
      let tgSetupUrl = `https://api.telegram.org/bot${token}/setWebhook?url=${encodeURIComponent(webhookUrl)}`;
      if (secret) {
        tgSetupUrl += `&secret_token=${encodeURIComponent(secret)}`;
      }
      const tgRes = await fetch(tgSetupUrl);
      const tgJson = await tgRes.json();
      return jsonResponse(tgJson, tgRes.status);
    }

    if (url.pathname === "/webhook" || url.pathname === "/api/telegram") {
      if (request.method === "POST") {
        return handleTelegramWebhook(request, env);
      }
      return jsonResponse({ ok: false, error: "Method not allowed" }, 405);
    }

    if (url.pathname.startsWith("/api/")) {
      return handleApiRoutes(url, request, env);
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      const botUsername = getBotUsername(env);
      const modifiedHtml = htmlContent.replaceAll(
        "__BOT_USERNAME__",
        botUsername,
      );
      return new Response(modifiedHtml, {
        status: 200,
        headers: {
          "Content-Type": "text/html;charset=UTF-8",
          ...HTML_SECURITY_HEADERS,
        },
      });
    }

    return new Response("Not Found", { status: 404 });
  },

  async scheduled(event, env = {}, ctx) {
    try {
      if (!env) return;
      const token = getBotToken(env);
      if (!token) return;
      await processReminders(env);
      await cleanupOldTrash(env);
    } catch (err) {}
  },
};

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
};

const HTML_SECURITY_HEADERS = {
  ...SECURITY_HEADERS,
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline' https://telegram.org; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self' https://api.telegram.org; img-src 'self' data:; frame-ancestors 'self' https://web.telegram.org https://*.telegram.org telegram:; base-uri 'self'; form-action 'self';",
};

const DEFAULT_CATEGORY_IDS = new Set([
  "cat-personal",
  "cat-work",
  "cat-shopping",
  "cat-health",
  "cat-finance",
]);

const VALID_PRIORITIES = new Set(["low", "normal", "high", "urgent"]);

const SUBTASK_COLS =
  "id, parent_task_id, parent_task_id as task_id, telegram_id, title, is_completed, is_deleted, deleted_at, reminder_time, is_reminder_sent, created_at, updated_at";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Telegram-Init-Data",
};

function handleCors() {
  return new Response(null, {
    status: 204,
    headers: {
      ...CORS_HEADERS,
      "Access-Control-Max-Age": "86400",
    },
  });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      Pragma: "no-cache",
      "X-Content-Type-Options": "nosniff",
      ...CORS_HEADERS,
    },
  });
}

function getBotToken(env) {
  if (!env) return "";
  const token = env.BOT_TOKEN || env.TELEGRAM_BOT_TOKEN || "";
  return token.trim();
}

function getBotUsername(env) {
  if (!env) return "";
  const name = env.BOT_USERNAME || env.TELEGRAM_BOT_USERNAME || "";
  return name.trim().replace(/^@/, "");
}

function getMiniAppUrl(env, requestUrl) {
  if (!env) return "";
  let appUrl = env.MINI_APP_URL || env.TELEGRAM_MINI_APP_URL || "";
  if (appUrl) {
    appUrl = appUrl.trim();
  } else if (requestUrl) {
    try {
      const parsed = new URL(requestUrl);
      appUrl = `https://${parsed.hostname}`;
    } catch (e) {
      appUrl = "";
    }
  }
  return appUrl;
}

function getReminderKeyboard(env, id, lang = "en", isMultiple = false) {
  const baseUrl = getMiniAppUrl(env, "") || "https://example.com";
  const sep = baseUrl.includes("?") ? "&" : "?";
  let btnLabel;
  if (lang === "ar") {
    btnLabel = isMultiple ? "عرض المهام" : "عرض المهمة";
  } else {
    btnLabel = isMultiple ? "View Tasks" : "View Task";
  }
  const param = id
    ? `startapp=${encodeURIComponent(id)}&tgWebAppStartParam=${encodeURIComponent(id)}`
    : "";
  const finalUrl = param ? `${baseUrl}${sep}${param}` : baseUrl;
  return {
    inline_keyboard: [
      [
        {
          text: btnLabel,
          web_app: {
            url: finalUrl,
          },
        },
      ],
    ],
  };
}

async function sendTelegramMessage(env, chatId, text, replyMarkup = null) {
  const token = getBotToken(env);
  if (!token) return { ok: false };
  const payload = {
    chat_id: chatId,
    text: text,
  };
  if (replyMarkup) {
    payload.reply_markup = replyMarkup;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, error: err };
  }
}

async function getUserLanguage(env, userId, from = null) {
  if (userId && env.DB) {
    const userSettings = await env.DB.prepare(
      `SELECT language FROM settings WHERE telegram_id = ?`,
    )
      .bind(userId)
      .first();
    if (userSettings && userSettings.language) {
      return userSettings.language === "ar" ? "ar" : "en";
    }
  }
  if (
    from &&
    from.language_code &&
    from.language_code.toLowerCase().startsWith("ar")
  ) {
    return "ar";
  }
  return "en";
}

function sanitizeTitle(raw) {
  if (typeof raw !== "string") return null;
  const title = raw.trim();
  if (!title) return null;
  if (title.startsWith("enc:v1:")) {
    const parts = title.split(":");
    return parts.length === 4 &&
      title.length <= 500 &&
      /^[a-zA-Z0-9+/=:]+$/.test(title)
      ? title
      : null;
  }
  return title.length <= 150 && !/[\u0000-\u001F\u007F]/.test(title)
    ? title
    : null;
}

function sanitizePriority(raw) {
  return VALID_PRIORITIES.has(raw) ? raw : "normal";
}

function sanitizeReminderTime(raw) {
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0
    ? Math.floor(raw)
    : null;
}

async function resolveCategoryId(env, rawCatId, userId) {
  const catId = typeof rawCatId === "string" ? rawCatId.trim() : "";
  if (!catId) return null;
  if (DEFAULT_CATEGORY_IDS.has(catId)) return catId;
  const check = await env.DB.prepare(
    `SELECT id FROM categories WHERE id = ? AND telegram_id = ?`,
  )
    .bind(catId, userId)
    .first();
  return check ? catId : null;
}

async function ensureUserExists(env, from) {
  if (!env || !env.DB || !from || !from.id) return;
  const now = Date.now();
  const userId = parseInt(from.id, 10);
  if (!userId || isNaN(userId)) return;
  const lang =
    from.language_code && from.language_code.toLowerCase().startsWith("ar")
      ? "ar"
      : "en";
  await env.DB.batch([
    env.DB.prepare(
      `
      INSERT INTO users (telegram_id, first_name, username, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(telegram_id) DO UPDATE SET
        first_name = excluded.first_name,
        username = excluded.username
    `,
    ).bind(userId, from.first_name || "", from.username || "", now),
    env.DB.prepare(
      `
      INSERT INTO settings (telegram_id, theme, theme_mode, accent_color, language, category_order, hidden_categories, updated_at)
      VALUES (?, 'mocha', 'manual', '#89b4fa', ?, NULL, NULL, ?)
      ON CONFLICT(telegram_id) DO NOTHING
    `,
    ).bind(userId, lang, now),
  ]);
}

async function authenticateRequest(request, env) {
  let initDataHeader =
    request.headers.get("Authorization") ||
    request.headers.get("X-Telegram-Init-Data") ||
    "";
  if (initDataHeader.startsWith("Bearer ")) {
    initDataHeader = initDataHeader.slice(7).trim();
  } else if (initDataHeader.startsWith("tma ")) {
    initDataHeader = initDataHeader.slice(4).trim();
  }
  initDataHeader = initDataHeader.trim();
  const token = getBotToken(env);
  if (!initDataHeader || !token) {
    return null;
  }
  return await verifyTelegramInitData(initDataHeader, token);
}

async function verifyTelegramInitData(initData, botToken) {
  try {
    if (!initData || !botToken) return null;
    const cleanInitData = initData.trim();
    const params = new URLSearchParams(cleanInitData);
    const hash = params.get("hash");
    if (!hash) return null;

    const authDate = parseInt(params.get("auth_date"), 10);
    if (!authDate || isNaN(authDate)) return null;
    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec - authDate > 86400 || authDate - nowSec > 300) {
      return null;
    }

    params.delete("hash");
    const sortedKeys = Array.from(params.keys()).sort();
    const dataCheckString = sortedKeys
      .map((k) => `${k}=${params.get(k)}`)
      .join("\n");

    const encoder = new TextEncoder();
    const secretKeyMaterial = await crypto.subtle.importKey(
      "raw",
      encoder.encode("WebAppData"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const secretKeyBuffer = await crypto.subtle.sign(
      "HMAC",
      secretKeyMaterial,
      encoder.encode(botToken),
    );

    const checkKey = await crypto.subtle.importKey(
      "raw",
      secretKeyBuffer,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const hashBuffer = await crypto.subtle.sign(
      "HMAC",
      checkKey,
      encoder.encode(dataCheckString),
    );
    const calculatedHash = Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    if (calculatedHash.length !== hash.length) {
      return null;
    }
    let mismatch = 0;
    const a = calculatedHash.toLowerCase();
    const b = hash.toLowerCase();
    for (let i = 0; i < a.length; i++) {
      mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    if (mismatch !== 0) {
      return null;
    }

    const userParam = params.get("user");
    if (userParam) {
      const user = JSON.parse(userParam);
      if (user && user.id) {
        return user;
      }
    }
    return null;
  } catch (e) {
    return null;
  }
}

async function handleTelegramWebhook(request, env) {
  try {
    if (request.method !== "POST") {
      return jsonResponse({ ok: false, error: "Method not allowed" }, 405);
    }
    const secret = (
      env.WEBHOOK_SECRET ||
      env.TELEGRAM_WEBHOOK_SECRET ||
      ""
    ).trim();
    if (secret) {
      const headerSecret = request.headers.get(
        "X-Telegram-Bot-Api-Secret-Token",
      );
      if (!headerSecret || headerSecret !== secret) {
        return jsonResponse({ ok: false, error: "Forbidden" }, 403);
      }
    }
    let update;
    try {
      update = await request.json();
    } catch (e) {
      return jsonResponse({ ok: false, error: "Invalid JSON" }, 400);
    }
    if (!update || !update.message) {
      return jsonResponse({ ok: true });
    }
    const message = update.message;
    const chatId = message.chat && message.chat.id;
    if (!chatId) {
      return jsonResponse({ ok: true });
    }
    const text = (message.text || "").trim();
    const from = message.from;
    if (from && from.id) {
      await ensureUserExists(env, from);
    }
    if (text.startsWith("/start")) {
      const firstName = from && from.first_name ? from.first_name : "";
      const appUrl = getMiniAppUrl(env, request.url);
      const isAr = (await getUserLanguage(env, from && from.id, from)) === "ar";
      const welcomeText = isAr
        ? `مرحباً ${firstName} في قائمة مهامك الشخصية!
أنا هنا لمساعدتك في تنظيم أعمالك، إعداد التنبيهات، ومتابعة إنجازاتك اليومية بسهولة تامة.

اضغط على زر "فتح التطبيق" بالأسفل للبدء.`
        : `Welcome ${firstName} to your personal To-Do List!
I am here to help you organize your tasks, set reminders, and track your daily achievements with ease.

Tap the "Open App" button below to get started.`;
      const buttonText = isAr ? "فتح التطبيق" : "Open App";

      if (appUrl) {
        const replyMarkup = {
          inline_keyboard: [
            [
              {
                text: buttonText,
                web_app: { url: appUrl },
              },
            ],
          ],
        };
        await sendTelegramMessage(env, chatId, welcomeText, replyMarkup);
      }
    }
    return jsonResponse({ ok: true });
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message }, 500);
  }
}

async function handleApiRoutes(url, request, env) {
  const user = await authenticateRequest(request, env);
  if (!user || !user.id) {
    return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
  }

  const userId = parseInt(user.id, 10);
  if (!userId || isNaN(userId)) {
    return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
  }

  const path = url.pathname;
  const method = request.method;

  if (!env.DB) {
    return jsonResponse(
      { ok: false, error: "Database binding DB missing" },
      500,
    );
  }

  if (path === "/api/sync" && method === "GET") {
    await ensureUserExists(env, user);
    const [
      tasksRes,
      subtasksRes,
      categoriesRes,
      settingsRes,
      trashTasksRes,
      trashSubtasksRes,
    ] = await env.DB.batch([
      env.DB.prepare(
        `SELECT * FROM tasks WHERE telegram_id = ? AND is_deleted = 0 ORDER BY created_at DESC`,
      ).bind(userId),
      env.DB.prepare(
        `SELECT ${SUBTASK_COLS} FROM sub_tasks WHERE telegram_id = ? AND is_deleted = 0 ORDER BY created_at ASC`,
      ).bind(userId),
      env.DB.prepare(
        `SELECT * FROM categories WHERE telegram_id = ? ORDER BY sort_order ASC, created_at ASC`,
      ).bind(userId),
      env.DB.prepare(
        `SELECT * FROM settings WHERE telegram_id = ?`,
      ).bind(userId),
      env.DB.prepare(
        `SELECT * FROM tasks WHERE telegram_id = ? AND is_deleted = 1 ORDER BY deleted_at DESC`,
      ).bind(userId),
      env.DB.prepare(
        `SELECT ${SUBTASK_COLS} FROM sub_tasks WHERE telegram_id = ? AND is_deleted = 1 ORDER BY deleted_at DESC`,
      ).bind(userId),
    ]);

    return jsonResponse({
      ok: true,
      data: {
        tasks: tasksRes.results || [],
        subtasks: subtasksRes.results || [],
        categories: categoriesRes.results || [],
        settings: (settingsRes.results && settingsRes.results[0]) || {},
        trash: {
          tasks: trashTasksRes.results || [],
          subtasks: trashSubtasksRes.results || [],
        },
      },
    });
  }

  if (path === "/api/tasks" && method === "POST") {
    const body = await request.json();
    const title = sanitizeTitle(body.title);
    if (!title) {
      return jsonResponse(
        {
          ok: false,
          error: "Title is invalid or exceeds 50 characters",
        },
        400,
      );
    }
    const id =
      typeof body.id === "string" && body.id.trim()
        ? body.id.trim()
        : crypto.randomUUID();
    const now = Date.now();
    const priority = sanitizePriority(body.priority);
    const reminderTime = sanitizeReminderTime(body.reminder_time);
    const categoryId = await resolveCategoryId(env, body.category_id, userId);

    if (!categoryId) {
      return jsonResponse({ ok: false, error: "Category is required" }, 400);
    }

    await env.DB.prepare(
      `
      INSERT INTO tasks (id, telegram_id, title, category_id, priority, is_completed, is_archived, is_deleted, reminder_time, is_reminder_sent, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 0, ?, ?)
    `,
    )
      .bind(
        id,
        userId,
        title,
        categoryId,
        priority,
        body.is_completed ? 1 : 0,
        body.is_archived ? 1 : 0,
        reminderTime,
        now,
        now,
      )
      .run();

    return jsonResponse({ ok: true, id });
  }

  if (path.startsWith("/api/tasks/")) {
    const pathParts = path.split("/");
    const id = pathParts[3];

    if (path.endsWith("/restore") && method === "POST") {
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE tasks SET is_deleted = 0, deleted_at = NULL WHERE id = ? AND telegram_id = ?`,
        ).bind(id, userId),
        env.DB.prepare(
          `UPDATE sub_tasks SET is_deleted = 0, deleted_at = NULL WHERE parent_task_id = ? AND telegram_id = ?`,
        ).bind(id, userId),
      ]);

      return jsonResponse({ ok: true });
    }

    if (path.endsWith("/permanent") && method === "DELETE") {
      await env.DB.batch([
        env.DB.prepare(
          `DELETE FROM sub_tasks WHERE parent_task_id = ? AND telegram_id = ?`,
        ).bind(id, userId),
        env.DB.prepare(
          `DELETE FROM tasks WHERE id = ? AND telegram_id = ?`,
        ).bind(id, userId),
      ]);
      return jsonResponse({ ok: true });
    }

    if (method === "PUT") {
      const body = await request.json();
      const title = sanitizeTitle(body.title);
      if (!title) {
        return jsonResponse(
          {
            ok: false,
            error: "Title is invalid or exceeds 50 characters",
          },
          400,
        );
      }
      const now = Date.now();
      const priority = sanitizePriority(body.priority);
      const isCompleted = body.is_completed ? 1 : 0;
      const isArchived = body.is_archived ? 1 : 0;
      const reminderTime = sanitizeReminderTime(body.reminder_time);
      const categoryId = await resolveCategoryId(env, body.category_id, userId);

      if (!categoryId) {
        return jsonResponse({ ok: false, error: "Category is required" }, 400);
      }

      await env.DB.prepare(
        `
        UPDATE tasks 
        SET title = ?,
            category_id = ?,
            priority = ?,
            is_completed = ?,
            is_archived = ?,
            reminder_time = ?,
            is_reminder_sent = CASE WHEN reminder_time IS NOT ? THEN 0 ELSE is_reminder_sent END,
            updated_at = ?
        WHERE id = ? AND telegram_id = ?
      `,
      )
        .bind(
          title,
          categoryId,
          priority,
          isCompleted,
          isArchived,
          reminderTime,
          reminderTime,
          now,
          id,
          userId,
        )
        .run();

      return jsonResponse({ ok: true });
    }

    if (method === "DELETE") {
      const now = Date.now();
      await env.DB.prepare(
        `
        UPDATE tasks 
        SET is_deleted = 1, deleted_at = ? 
        WHERE id = ? AND telegram_id = ?
      `,
      )
        .bind(now, id, userId)
        .run();

      await env.DB.prepare(
        `
        UPDATE sub_tasks 
        SET is_deleted = 1, deleted_at = ? 
        WHERE parent_task_id = ? AND telegram_id = ?
      `,
      )
        .bind(now, id, userId)
        .run();

      return jsonResponse({ ok: true });
    }
  }

  if (path === "/api/subtasks" && method === "POST") {
    const body = await request.json();
    const title = sanitizeTitle(body.title);
    if (!title) {
      return jsonResponse(
        {
          ok: false,
          error: "Title is invalid or exceeds 50 characters",
        },
        400,
      );
    }
    const id =
      typeof body.id === "string" && body.id.trim()
        ? body.id.trim()
        : crypto.randomUUID();
    const now = Date.now();
    const parentId = body.parent_task_id || body.task_id;
    if (!parentId || typeof parentId !== "string") {
      return jsonResponse(
        { ok: false, error: "Parent task ID is required" },
        400,
      );
    }
    const reminderTime = sanitizeReminderTime(body.reminder_time);

    const parentTask = await env.DB.prepare(
      `SELECT id FROM tasks WHERE id = ? AND telegram_id = ?`,
    )
      .bind(parentId, userId)
      .first();
    if (!parentTask) {
      return jsonResponse({ ok: false, error: "Parent task not found" }, 404);
    }

    await env.DB.prepare(
      `
      INSERT INTO sub_tasks (id, parent_task_id, telegram_id, title, is_completed, is_deleted, reminder_time, is_reminder_sent, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, ?, 0, ?, ?)
    `,
    )
      .bind(
        id,
        parentId,
        userId,
        title,
        body.is_completed ? 1 : 0,
        reminderTime,
        now,
        now,
      )
      .run();

    return jsonResponse({ ok: true, id });
  }

  if (path.startsWith("/api/subtasks/")) {
    const pathParts = path.split("/");
    const id = pathParts[3];

    if (path.endsWith("/restore") && method === "POST") {
      const sub = await env.DB.prepare(
        `SELECT parent_task_id FROM sub_tasks WHERE id = ? AND telegram_id = ?`,
      )
        .bind(id, userId)
        .first();
      if (sub) {
        const parentId = sub.parent_task_id;
        await env.DB.prepare(
          `
          UPDATE sub_tasks 
          SET is_deleted = 0, deleted_at = NULL 
          WHERE id = ? AND telegram_id = ?
        `,
        )
          .bind(id, userId)
          .run();

        if (parentId) {
          const parentTask = await env.DB.prepare(
            `SELECT is_deleted FROM tasks WHERE id = ? AND telegram_id = ?`,
          )
            .bind(parentId, userId)
            .first();
          if (parentTask && parentTask.is_deleted === 1) {
            await env.DB.prepare(
              `
              UPDATE tasks 
              SET is_deleted = 0, deleted_at = NULL 
              WHERE id = ? AND telegram_id = ?
            `,
            )
              .bind(parentId, userId)
              .run();
          }
        }
      }

      return jsonResponse({ ok: true });
    }

    if (path.endsWith("/permanent") && method === "DELETE") {
      await env.DB.prepare(
        `DELETE FROM sub_tasks WHERE id = ? AND telegram_id = ?`,
      )
        .bind(id, userId)
        .run();
      return jsonResponse({ ok: true });
    }

    if (method === "PUT") {
      const body = await request.json();
      const title = sanitizeTitle(body.title);
      if (!title) {
        return jsonResponse(
          {
            ok: false,
            error: "Title is invalid or exceeds 50 characters",
          },
          400,
        );
      }
      const now = Date.now();
      const parentId = body.parent_task_id || body.task_id;
      const isCompleted = body.is_completed ? 1 : 0;
      const reminderTime = sanitizeReminderTime(body.reminder_time);

      if (parentId) {
        const parentTask = await env.DB.prepare(
          `SELECT id FROM tasks WHERE id = ? AND telegram_id = ?`,
        )
          .bind(parentId, userId)
          .first();
        if (!parentTask) {
          return jsonResponse(
            { ok: false, error: "Parent task not found" },
            404,
          );
        }
      }

      await env.DB.prepare(
        `
        UPDATE sub_tasks 
        SET title = ?,
            parent_task_id = ?,
            is_completed = ?,
            reminder_time = ?,
            is_reminder_sent = CASE WHEN reminder_time IS NOT ? THEN 0 ELSE is_reminder_sent END,
            updated_at = ?
        WHERE id = ? AND telegram_id = ?
      `,
      )
        .bind(
          title,
          parentId,
          isCompleted,
          reminderTime,
          reminderTime,
          now,
          id,
          userId,
        )
        .run();

      return jsonResponse({ ok: true });
    }

    if (method === "DELETE") {
      const now = Date.now();
      await env.DB.prepare(
        `
        UPDATE sub_tasks 
        SET is_deleted = 1, deleted_at = ? 
        WHERE id = ? AND telegram_id = ?
      `,
      )
        .bind(now, id, userId)
        .run();

      return jsonResponse({ ok: true });
    }
  }

  if (path === "/api/categories" && method === "POST") {
    const body = await request.json();
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 1000) {
      return jsonResponse(
        {
          ok: false,
          error: "Category name must be between 1 and 1000 characters",
        },
        400,
      );
    }
    const id =
      typeof body.id === "string" && body.id.trim()
        ? body.id.trim()
        : crypto.randomUUID();
    const now = Date.now();
    const sortOrder =
      typeof body.sort_order === "number" && Number.isFinite(body.sort_order)
        ? Math.floor(body.sort_order)
        : 0;
    await env.DB.prepare(
      `
      INSERT INTO categories (id, telegram_id, name, is_default, sort_order, created_at)
      VALUES (?, ?, ?, 0, ?, ?)
    `,
    )
      .bind(id, userId, name, sortOrder, now)
      .run();

    return jsonResponse({ ok: true, id });
  }

  if (path === "/api/categories/reorder" && method === "POST") {
    const body = await request.json();
    const orderList = Array.isArray(body.order) ? body.order.slice(0, 100) : [];
    if (orderList.length > 0) {
      const stmts = orderList
        .filter((catId) => typeof catId === "string" && catId.length <= 100)
        .map((catId, i) =>
          env.DB.prepare(
            `UPDATE categories SET sort_order = ? WHERE id = ? AND telegram_id = ?`,
          ).bind(i, catId, userId),
        );
      if (stmts.length > 0) {
        await env.DB.batch(stmts);
      }
    }
    return jsonResponse({ ok: true });
  }

  if (path.startsWith("/api/categories/") && method === "DELETE") {
    const id = path.split("/")[3];
    const cat = await env.DB.prepare(
      `SELECT id FROM categories WHERE id = ? AND telegram_id = ? AND is_default = 0`,
    )
      .bind(id, userId)
      .first();
    if (cat) {
      await env.DB.batch([
        env.DB.prepare(
          `DELETE FROM categories WHERE id = ? AND telegram_id = ? AND is_default = 0`,
        ).bind(id, userId),
        env.DB.prepare(
          `UPDATE tasks SET category_id = 'cat-personal' WHERE category_id = ? AND telegram_id = ?`,
        ).bind(id, userId),
      ]);
    }
    return jsonResponse({ ok: true });
  }

  if (path === "/api/settings" && method === "POST") {
    const body = await request.json();
    const now = Date.now();
    const theme =
      typeof body.theme === "string" && /^[a-zA-Z0-9_-]{1,50}$/.test(body.theme)
        ? body.theme
        : "mocha";
    const themeMode = ["manual", "auto", "system"].includes(body.theme_mode)
      ? body.theme_mode
      : "manual";
    const accentColor =
      typeof body.accent_color === "string" &&
      /^#[0-9a-fA-F]{3,8}$/.test(body.accent_color)
        ? body.accent_color
        : "#89b4fa";
    const language = body.language === "ar" ? "ar" : "en";

    const serializeJsonSafe = (val, maxLen = 5000) => {
      if (val === undefined || val === null) return null;
      const str = typeof val === "string" ? val : JSON.stringify(val);
      return str.length <= maxLen ? str : null;
    };

    await env.DB.prepare(
      `
      INSERT INTO settings (telegram_id, theme, theme_mode, accent_color, language, category_order, hidden_categories, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(telegram_id) DO UPDATE SET
        theme = excluded.theme,
        theme_mode = excluded.theme_mode,
        accent_color = excluded.accent_color,
        language = excluded.language,
        category_order = excluded.category_order,
        hidden_categories = excluded.hidden_categories,
        updated_at = excluded.updated_at
    `,
    )
      .bind(
        userId,
        theme,
        themeMode,
        accentColor,
        language,
        serializeJsonSafe(body.category_order),
        serializeJsonSafe(body.hidden_categories),
        now,
      )
      .run();

    return jsonResponse({ ok: true });
  }

  if (
    path === "/api/trash/empty" &&
    (method === "POST" || method === "DELETE")
  ) {
    await env.DB.batch([
      env.DB.prepare(
        `DELETE FROM sub_tasks WHERE telegram_id = ? AND is_deleted = 1`,
      ).bind(userId),
      env.DB.prepare(
        `DELETE FROM tasks WHERE telegram_id = ? AND is_deleted = 1`,
      ).bind(userId),
    ]);
    return jsonResponse({ ok: true });
  }

  if (path === "/api/backup" && method === "GET") {
    const tasks = await env.DB.prepare(
      `SELECT * FROM tasks WHERE telegram_id = ?`,
    )
      .bind(userId)
      .all();
    const subtasks = await env.DB.prepare(
      `
      SELECT ${SUBTASK_COLS}
      FROM sub_tasks 
      WHERE telegram_id = ?
    `,
    )
      .bind(userId)
      .all();
    const categories = await env.DB.prepare(
      `SELECT * FROM categories WHERE telegram_id = ? ORDER BY sort_order ASC, created_at ASC`,
    )
      .bind(userId)
      .all();
    const settings = await env.DB.prepare(
      `SELECT * FROM settings WHERE telegram_id = ?`,
    )
      .bind(userId)
      .first();

    return jsonResponse({
      ok: true,
      backup: {
        version: 3,
        exported_at: Date.now(),
        settings: settings || {},
        categories: categories.results || [],
        tasks: tasks.results || [],
        subtasks: subtasks.results || [],
      },
    });
  }

  if (path === "/api/backup/send" && method === "POST") {
    const body = await request.json();
    const backupData = body.backup;
    if (!backupData) return jsonResponse({ ok: false, error: "No data" }, 400);

    const jsonString = JSON.stringify(backupData, null, 2);
    const filename = `todo_backup_${new Date().toISOString().slice(0, 10)}.json`;
    const token = getBotToken(env);

    const userRes = await env.DB.prepare(
      `SELECT language FROM settings WHERE telegram_id = ?`,
    )
      .bind(userId)
      .first();
    const isAr = userRes && userRes.language === "ar";
    const captionText = isAr
      ? "نسخة احتياطية لبياناتك.\n\nيمكنك استعادتها لاحقاً عبر استيرادها من إعدادات التطبيق."
      : "Backup of your data.\n\nTo restore it later, import it inside the app settings.";

    const formData = new FormData();
    formData.append("chat_id", userId);
    formData.append(
      "document",
      new Blob([jsonString], { type: "application/json" }),
      filename,
    );
    formData.append("caption", captionText);

    await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
      method: "POST",
      body: formData,
    });

    return jsonResponse({ ok: true });
  }

  if (path === "/api/restore" && method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return jsonResponse({ ok: false, error: "Invalid JSON" }, 400);
    }
    const backup = body && (body.backup || body);
    if (!backup || typeof backup !== "object" || !Array.isArray(backup.tasks)) {
      return jsonResponse({ ok: false, error: "Invalid backup data" }, 400);
    }
    if (backup.tasks.length > 5000) {
      return jsonResponse({ ok: false, error: "Task limit exceeded" }, 400);
    }
    for (const t of backup.tasks) {
      if (!t || typeof t !== "object" || !sanitizeTitle(t.title)) {
        return jsonResponse(
          { ok: false, error: "Invalid task in backup" },
          400,
        );
      }
    }
    if (backup.subtasks) {
      if (!Array.isArray(backup.subtasks) || backup.subtasks.length > 20000) {
        return jsonResponse(
          { ok: false, error: "Invalid subtasks in backup" },
          400,
        );
      }
      for (const s of backup.subtasks) {
        if (!s || typeof s !== "object" || !sanitizeTitle(s.title)) {
          return jsonResponse(
            { ok: false, error: "Invalid subtask in backup" },
            400,
          );
        }
      }
    }
    if (backup.categories) {
      if (!Array.isArray(backup.categories) || backup.categories.length > 100) {
        return jsonResponse(
          { ok: false, error: "Invalid categories in backup" },
          400,
        );
      }
      for (const c of backup.categories) {
        if (
          !c ||
          typeof c !== "object" ||
          typeof c.name !== "string" ||
          !c.name.trim() ||
          c.name.length > 500
        ) {
          return jsonResponse(
            { ok: false, error: "Invalid category in backup" },
            400,
          );
        }
      }
    }
    await executeRestoreDB(env, userId, backup);
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ ok: false, error: "Not found" }, 404);
}

async function processReminders(env) {
  if (!env || !env.DB) return;
  const token = getBotToken(env);
  if (!token) return;
  const now = Date.now();
  const dueTasks = await env.DB.prepare(
    `
    SELECT id, telegram_id, title 
    FROM tasks 
    WHERE reminder_time IS NOT NULL 
      AND reminder_time <= ? 
      AND is_reminder_sent = 0 
      AND is_completed = 0 
      AND is_archived = 0 
      AND is_deleted = 0
  `,
  )
    .bind(now)
    .all();

  const dueSubtasks = await env.DB.prepare(
    `
    SELECT s.id, s.telegram_id, s.title, t.title as parent_title 
    FROM sub_tasks s
    JOIN tasks t ON s.parent_task_id = t.id
    WHERE s.reminder_time IS NOT NULL 
      AND s.reminder_time <= ? 
      AND s.is_reminder_sent = 0 
      AND s.is_completed = 0 
      AND s.is_deleted = 0
      AND t.is_archived = 0
      AND t.is_deleted = 0
  `,
  )
    .bind(now)
    .all();

  const userReminders = new Map();

  if (dueTasks.results && dueTasks.results.length > 0) {
    for (const task of dueTasks.results) {
      const uid = task.telegram_id;
      if (!userReminders.has(uid)) {
        userReminders.set(uid, { taskIds: [], subtaskIds: [], items: [] });
      }
      const data = userReminders.get(uid);
      data.taskIds.push(task.id);
      data.items.push({ id: task.id, title: task.title });
    }
  }

  if (dueSubtasks.results && dueSubtasks.results.length > 0) {
    for (const sub of dueSubtasks.results) {
      const uid = sub.telegram_id;
      if (!userReminders.has(uid)) {
        userReminders.set(uid, { taskIds: [], subtaskIds: [], items: [] });
      }
      const data = userReminders.get(uid);
      data.subtaskIds.push(sub.id);
      const displayTitle = sub.parent_title
        ? `${sub.title} (${sub.parent_title})`
        : sub.title;
      data.items.push({ id: sub.id, title: displayTitle });
    }
  }

  for (const [userId, data] of userReminders.entries()) {
    if (!data.items.length) continue;
    const isAr = (await getUserLanguage(env, userId)) === "ar";
    const isMultiple = data.items.length > 1;

    const isEncrypted = (str) =>
      typeof str === "string" && str.startsWith("enc:v1:");
    const anyEncrypted = data.items.some((it) => isEncrypted(it.title));

    let messageText;
    if (anyEncrypted) {
      if (isMultiple) {
        messageText = isAr
          ? `🔔 تذكير: لديك (${data.items.length}) مهام مستحقة الآن.\n\nاضغط على الزر أدناه لعرض تفاصيل المهام.`
          : `🔔 Reminder: You have (${data.items.length}) due tasks right now.\n\nClick the button below to view your tasks.`;
      } else {
        messageText = isAr
          ? `🔔 تذكير: لديك مهمة مستحقة الآن!\n\nاضغط على الزر أدناه لعرض تفاصيل المهمة.`
          : `🔔 Reminder: You have a due task now!\n\nClick the button below to view your task.`;
      }
    } else {
      if (isMultiple) {
        const taskListStr = data.items.map((it) => `• ${it.title}`).join("\n");
        messageText = isAr
          ? `تذكير بالمهام المستحقة (${data.items.length}):\n${taskListStr}`
          : `Due Tasks Reminder (${data.items.length}):\n${taskListStr}`;
      } else {
        messageText = isAr
          ? `تذكير بمهمتك:\n• ${data.items[0].title}`
          : `Task Reminder:\n• ${data.items[0].title}`;
      }
    }

    const firstId = data.items[0].id;
    const keyboard = getReminderKeyboard(
      env,
      isMultiple ? "due_now" : firstId,
      isAr ? "ar" : "en",
      isMultiple,
    );

    const sendRes = await sendTelegramMessage(env, userId, messageText, keyboard);
    if (!sendRes || sendRes.ok || sendRes.status === 403 || sendRes.status === 400) {
      const updateStmts = [
        ...data.taskIds.map((id) =>
          env.DB.prepare(
            `UPDATE tasks SET is_reminder_sent = 1 WHERE id = ? AND telegram_id = ?`,
          ).bind(id, userId),
        ),
        ...data.subtaskIds.map((id) =>
          env.DB.prepare(
            `UPDATE sub_tasks SET is_reminder_sent = 1 WHERE id = ? AND telegram_id = ?`,
          ).bind(id, userId),
        ),
      ];
      if (updateStmts.length > 0) {
        await env.DB.batch(updateStmts);
      }
    }
  }
}

async function cleanupOldTrash(env) {
  if (!env || !env.DB) return;
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM sub_tasks WHERE is_deleted = 1 AND deleted_at < ?`,
    ).bind(thirtyDaysAgo),
    env.DB.prepare(
      `DELETE FROM tasks WHERE is_deleted = 1 AND deleted_at < ?`,
    ).bind(thirtyDaysAgo),
  ]);
}

async function executeRestoreDB(env, userId, backup) {
  const now = Date.now();
  if (backup.settings) {
    const catOrderVal =
      backup.settings.category_order !== undefined
        ? typeof backup.settings.category_order === "string"
          ? backup.settings.category_order
          : JSON.stringify(backup.settings.category_order)
        : null;
    const hiddenCatVal =
      backup.settings.hidden_categories !== undefined
        ? typeof backup.settings.hidden_categories === "string"
          ? backup.settings.hidden_categories
          : JSON.stringify(backup.settings.hidden_categories)
        : null;
    await env.DB.prepare(
      `
      INSERT INTO settings (telegram_id, theme, theme_mode, accent_color, language, category_order, hidden_categories, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(telegram_id) DO UPDATE SET
        theme = excluded.theme,
        theme_mode = excluded.theme_mode,
        accent_color = excluded.accent_color,
        language = excluded.language,
        category_order = excluded.category_order,
        hidden_categories = excluded.hidden_categories,
        updated_at = excluded.updated_at
    `,
    )
      .bind(
        userId,
        backup.settings.theme || "mocha",
        backup.settings.theme_mode || "manual",
        backup.settings.accent_color || "#89b4fa",
        backup.settings.language || "en",
        catOrderVal,
        hiddenCatVal,
        now,
      )
      .run();
  }
  const stmts = [];

  if (Array.isArray(backup.categories)) {
    for (let i = 0; i < backup.categories.length; i++) {
      const cat = backup.categories[i];
      const sOrder = cat.sort_order !== undefined ? cat.sort_order : i;
      const catId = cat.id || crypto.randomUUID();
      stmts.push(
        env.DB.prepare(
          `INSERT INTO categories (id, telegram_id, name, is_default, sort_order, created_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             sort_order = excluded.sort_order`,
        ).bind(
          catId,
          userId,
          cat.name,
          cat.is_default ? 1 : 0,
          sOrder,
          cat.created_at || now,
        ),
      );
    }
  }

  if (Array.isArray(backup.tasks)) {
    for (const t of backup.tasks) {
      const taskId = t.id || crypto.randomUUID();
      stmts.push(
        env.DB.prepare(
          `INSERT INTO tasks (id, telegram_id, title, category_id, priority, is_completed, is_archived, is_deleted, deleted_at, reminder_time, is_reminder_sent, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             title = excluded.title,
             category_id = excluded.category_id,
             priority = excluded.priority,
             is_completed = excluded.is_completed,
             is_archived = excluded.is_archived,
             is_deleted = excluded.is_deleted,
             deleted_at = excluded.deleted_at,
             reminder_time = excluded.reminder_time,
             is_reminder_sent = excluded.is_reminder_sent,
             updated_at = excluded.updated_at`,
        ).bind(
          taskId,
          userId,
          t.title,
          t.category_id || null,
          t.priority || "normal",
          t.is_completed ? 1 : 0,
          t.is_archived ? 1 : 0,
          t.is_deleted ? 1 : 0,
          t.deleted_at || null,
          t.reminder_time || null,
          t.is_reminder_sent ? 1 : 0,
          t.created_at || now,
          now,
        ),
      );
    }
  }

  if (Array.isArray(backup.subtasks)) {
    for (const s of backup.subtasks) {
      const subId = s.id || crypto.randomUUID();
      const parentId = s.parent_task_id || s.task_id;
      stmts.push(
        env.DB.prepare(
          `INSERT INTO sub_tasks (id, parent_task_id, telegram_id, title, is_completed, is_deleted, deleted_at, reminder_time, is_reminder_sent, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             parent_task_id = excluded.parent_task_id,
             title = excluded.title,
             is_completed = excluded.is_completed,
             is_deleted = excluded.is_deleted,
             deleted_at = excluded.deleted_at,
             reminder_time = excluded.reminder_time,
             is_reminder_sent = excluded.is_reminder_sent,
             updated_at = excluded.updated_at`,
        ).bind(
          subId,
          parentId,
          userId,
          s.title,
          s.is_completed ? 1 : 0,
          s.is_deleted ? 1 : 0,
          s.deleted_at || null,
          s.reminder_time || null,
          s.is_reminder_sent ? 1 : 0,
          s.created_at || now,
          now,
        ),
      );
    }
  }

  for (let i = 0; i < stmts.length; i += 100) {
    await env.DB.batch(stmts.slice(i, i + 100));
  }
}

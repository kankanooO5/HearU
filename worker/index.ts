interface Env {
  ASSEMBLYAI_API_KEY?: string;
  DEEPSEEK_API_KEY?: string;
  SYNC_KEY?: string;
  hearu_sync: D1Database;
}

interface TranslationRequest {
  texts?: unknown;
  source?: unknown;
  vocabulary?: unknown;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function sanitizeVocabulary(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  return value
    .filter(
      (word): word is string =>
        typeof word === "string" &&
        word.length <= 80 &&
        !/[<>\r\n]/.test(word),
    )
    .slice(0, 60);
}

function parseTranslationTexts(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 3
  ) {
    throw new Error("翻译文本数量超出范围");
  }

  if (
    value.some(
      (text) =>
        typeof text !== "string" ||
        !text.trim() ||
        text.length > 2500,
    )
  ) {
    throw new Error("翻译文本长度超出范围");
  }

  return value;
}

function isSameOriginPost(
  request: Request,
  url: URL,
): boolean {
  return (
    request.method === "POST" &&
    request.headers.get("origin") === url.origin
  );
}

function isAuthorizedSyncRequest(
  request: Request,
  env: Env,
): boolean {
  const key = request.headers.get("x-hearu-sync-key");

  return Boolean(
    env.SYNC_KEY &&
    key &&
    key === env.SYNC_KEY,
  );
}

async function handleTranscriptionToken(
  _request: Request,
  apiKey: string,
): Promise<Response> {
  try {
    const url = new URL(
      "https://streaming.assemblyai.com/v3/token",
    );

    url.searchParams.set(
      "expires_in_seconds",
      "60",
    );

    url.searchParams.set(
      "max_session_duration_seconds",
      "10800",
    );

    const response = await fetch(url, {
      headers: {
        authorization: apiKey,
      },
    });

    const result = await response
      .json()
      .catch(() => ({})) as {
        token?: unknown;
        error?: unknown;
      };

    if (!response.ok) {
      throw new Error(
        typeof result.error === "string"
          ? result.error
          : `AssemblyAI 响应 ${response.status}`,
      );
    }

    if (
      typeof result.token !== "string" ||
      !result.token
    ) {
      throw new Error(
        "未收到有效的实时识别临时凭证",
      );
    }

    return json({
      token: result.token,
    });
  } catch (error) {
    return json(
      {
        error:
          error instanceof Error
            ? error.message
            : "在线语音服务暂时不可用",
      },
      502,
    );
  }
}

async function handleTranslation(
  request: Request,
  apiKey: string,
): Promise<Response> {
  try {
    const body =
      (await request.json()) as TranslationRequest;

    const texts =
      parseTranslationTexts(body.texts);

    const source =
      body.source === "zh" ? "zh" : "it";

    const vocabulary =
      sanitizeVocabulary(body.vocabulary);

    const direction =
      source === "zh"
        ? "将中文译为自然、简洁的意大利语"
        : "将意大利语译为准确、简洁的中文";

    const terms = vocabulary
      .join("、")
      .slice(0, 1500);

    const response = await fetch(
      "https://api.deepseek.com/chat/completions",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "deepseek-flash",
          thinking: {
            type: "disabled",
          },
          max_tokens: 700,
          response_format: {
            type: "json_object",
          },
          messages: [
            {
              role: "system",
              content:
                `${direction}。` +
                `输入是字符串数组，按原顺序逐项翻译，每项对应一段。` +
                `保留人物、地名和专业术语，忠实于原文，允许句子未完。` +
                `只输出 JSON，不要输出解释或 Markdown。` +
                `JSON 格式必须为：{"translations":["译文1","译文2"]}。` +
                `课程术语：${terms}`,
            },
            {
              role: "user",
              content: JSON.stringify(texts),
            },
          ],
        }),
      },
    );

    const result = await response
      .json()
      .catch(() => ({})) as {
        choices?: Array<{
          message?: {
            content?: unknown;
          };
        }>;
        error?: {
          message?: unknown;
        };
      };

    if (!response.ok) {
      throw new Error(
        typeof result.error?.message === "string"
          ? result.error.message
          : `DeepSeek 响应 ${response.status}`,
      );
    }

    const outputText =
      result.choices?.[0]?.message?.content;

    if (
      typeof outputText !== "string" ||
      !outputText
    ) {
      throw new Error(
        "翻译服务未返回有效内容",
      );
    }

    const parsed =
      JSON.parse(outputText) as {
        translations?: unknown;
      };

    if (
      !Array.isArray(parsed.translations) ||
      parsed.translations.length !== texts.length ||
      parsed.translations.some(
        (value) => typeof value !== "string",
      )
    ) {
      throw new Error(
        "翻译响应格式暂时异常",
      );
    }

    return json({
      texts: parsed.translations,
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "在线翻译服务暂时不可用";

    const status =
      message.startsWith("翻译文本")
        ? 400
        : 502;

    return json(
      { error: message },
      status,
    );
  }
}


type SyncCourse = {
  id: string;
  name: string;
  vocabulary: string[];
  updatedAt: number;
};

type SyncSession = {
  id: string;
  course: string;
  mode: "classroom" | "conversation";
  language: "it" | "zh";
  startedAt: string;
  endedAt?: string;
  duration: number;
  vocabulary: string[];
  chunks: number;
  updatedAt: number;
};

type SyncLine = {
  sessionId: string;
  id: string;
  order: number;
  start: number;
  end: number;
  stable: string;
  active: string;
  locked: boolean;
  translation: string;
  translatedChars: number;
  lastQueuedAt: number;
  updatedAt: number;
};

type SyncPushRequest = {
  courses?: unknown;
  sessions?: unknown;
  lines?: unknown;
};

function record(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new Error("同步数据格式无效");
  }

  return value as Record<string, unknown>;
}

function syncString(
  value: unknown,
  max: number,
): string {
  if (
    typeof value !== "string" ||
    value.length > max
  ) {
    throw new Error("同步文本格式无效");
  }

  return value;
}

function syncNumber(
  value: unknown,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value)
  ) {
    throw new Error("同步数字格式无效");
  }

  return value;
}

function syncTimestamp(
  value: unknown,
): number {
  const timestamp = syncNumber(value);

  if (timestamp < 0) {
    throw new Error("同步时间格式无效");
  }

  return Math.floor(timestamp);
}

function parseSyncCourses(
  value: unknown,
): SyncCourse[] {
  if (value === undefined) return [];

  if (
    !Array.isArray(value) ||
    value.length > 100
  ) {
    throw new Error("课程同步批次过大");
  }

  return value.map((item) => {
    const x = record(item);

    return {
      id: syncString(x.id, 200),
      name: syncString(x.name, 200),
      vocabulary:
        sanitizeVocabulary(x.vocabulary),
      updatedAt:
        syncTimestamp(x.updatedAt),
    };
  });
}

function parseSyncSessions(
  value: unknown,
): SyncSession[] {
  if (value === undefined) return [];

  if (
    !Array.isArray(value) ||
    value.length > 100
  ) {
    throw new Error("课堂同步批次过大");
  }

  return value.map((item) => {
    const x = record(item);

    if (
      x.mode !== "classroom" &&
      x.mode !== "conversation"
    ) {
      throw new Error("课堂模式无效");
    }

    if (
      x.language !== "it" &&
      x.language !== "zh"
    ) {
      throw new Error("课堂语言无效");
    }

    const endedAt =
      x.endedAt === undefined ||
      x.endedAt === null
        ? undefined
        : syncString(x.endedAt, 100);

    return {
      id: syncString(x.id, 200),
      course: syncString(x.course, 300),
      mode: x.mode,
      language: x.language,
      startedAt:
        syncString(x.startedAt, 100),
      endedAt,
      duration:
        syncNumber(x.duration),
      vocabulary:
        sanitizeVocabulary(x.vocabulary),
      chunks:
        Math.max(
          0,
          Math.floor(syncNumber(x.chunks)),
        ),
      updatedAt:
        syncTimestamp(x.updatedAt),
    };
  });
}

function parseSyncLines(
  value: unknown,
): SyncLine[] {
  if (value === undefined) return [];

  if (
    !Array.isArray(value) ||
    value.length > 500
  ) {
    throw new Error("字幕同步批次过大");
  }

  return value.map((item) => {
    const x = record(item);

    return {
      sessionId:
        syncString(x.sessionId, 200),
      id:
        syncString(x.id, 300),
      order:
        Math.max(
          0,
          Math.floor(syncNumber(x.order)),
        ),
      start:
        syncNumber(x.start),
      end:
        syncNumber(x.end),
      stable:
        syncString(x.stable, 20000),
      active:
        syncString(x.active, 20000),
      locked:
        Boolean(x.locked),
      translation:
        syncString(x.translation, 20000),
      translatedChars:
        Math.max(
          0,
          Math.floor(
            syncNumber(x.translatedChars),
          ),
        ),
      lastQueuedAt:
        syncNumber(x.lastQueuedAt),
      updatedAt:
        syncTimestamp(x.updatedAt),
    };
  });
}

function storedVocabulary(
  value: string,
): string[] {
  try {
    return sanitizeVocabulary(
      JSON.parse(value),
    );
  } catch {
    return [];
  }
}

async function handleSyncPush(
  request: Request,
  env: Env,
): Promise<Response> {
  try {
    const body =
      (await request.json()) as SyncPushRequest;

    const courses =
      parseSyncCourses(body.courses);

    const sessions =
      parseSyncSessions(body.sessions);

    const lines =
      parseSyncLines(body.lines);

    const statements:
      D1PreparedStatement[] = [];

    for (const course of courses) {
      statements.push(
        env.hearu_sync.prepare(`
          INSERT INTO courses (
            id,
            name,
            vocabulary_json,
            updated_at
          )
          VALUES (?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            vocabulary_json = excluded.vocabulary_json,
            updated_at = excluded.updated_at
          WHERE
            excluded.updated_at >= courses.updated_at
        `).bind(
          course.id,
          course.name,
          JSON.stringify(course.vocabulary),
          course.updatedAt,
        ),
      );
    }

    for (const session of sessions) {
      statements.push(
        env.hearu_sync.prepare(`
          INSERT INTO sessions (
            id,
            course,
            mode,
            language,
            started_at,
            ended_at,
            duration,
            vocabulary_json,
            chunks,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            course = excluded.course,
            mode = excluded.mode,
            language = excluded.language,
            started_at = excluded.started_at,
            ended_at = excluded.ended_at,
            duration = excluded.duration,
            vocabulary_json = excluded.vocabulary_json,
            chunks = excluded.chunks,
            updated_at = excluded.updated_at
          WHERE
            excluded.updated_at >= sessions.updated_at
        `).bind(
          session.id,
          session.course,
          session.mode,
          session.language,
          session.startedAt,
          session.endedAt ?? null,
          session.duration,
          JSON.stringify(session.vocabulary),
          session.chunks,
          session.updatedAt,
        ),
      );
    }

    for (const line of lines) {
      statements.push(
        env.hearu_sync.prepare(`
          INSERT INTO lines (
            session_id,
            id,
            line_order,
            start,
            end,
            stable,
            active,
            locked,
            translation,
            translated_chars,
            last_queued_at,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(session_id, id) DO UPDATE SET
            line_order = excluded.line_order,
            start = excluded.start,
            end = excluded.end,
            stable = excluded.stable,
            active = excluded.active,
            locked = excluded.locked,
            translation = excluded.translation,
            translated_chars = excluded.translated_chars,
            last_queued_at = excluded.last_queued_at,
            updated_at = excluded.updated_at
          WHERE
            excluded.updated_at >= lines.updated_at
        `).bind(
          line.sessionId,
          line.id,
          line.order,
          line.start,
          line.end,
          line.stable,
          line.active,
          line.locked ? 1 : 0,
          line.translation,
          line.translatedChars,
          line.lastQueuedAt,
          line.updatedAt,
        ),
      );
    }

    if (statements.length) {
      await env.hearu_sync.batch(
        statements,
      );
    }

    return json({
      ok: true,
      courses: courses.length,
      sessions: sessions.length,
      lines: lines.length,
    });
  } catch (error) {
    return json(
      {
        error:
          error instanceof Error
            ? error.message
            : "同步写入失败",
      },
      400,
    );
  }
}

async function handleSyncPull(
  request: Request,
  env: Env,
): Promise<Response> {
  try {
    const url = new URL(request.url);

    const sessionId =
      url.searchParams.get("session");

    const coursesResult =
      await env.hearu_sync
        .prepare(`
          SELECT
            id,
            name,
            vocabulary_json,
            updated_at
          FROM courses
          ORDER BY name
        `)
        .all<{
          id: string;
          name: string;
          vocabulary_json: string;
          updated_at: number;
        }>();

    const sessionsResult =
      await env.hearu_sync
        .prepare(`
          SELECT
            id,
            course,
            mode,
            language,
            started_at,
            ended_at,
            duration,
            vocabulary_json,
            chunks,
            updated_at
          FROM sessions
          ORDER BY started_at DESC
        `)
        .all<{
          id: string;
          course: string;
          mode: "classroom" | "conversation";
          language: "it" | "zh";
          started_at: string;
          ended_at: string | null;
          duration: number;
          vocabulary_json: string;
          chunks: number;
          updated_at: number;
        }>();

    let lines: SyncLine[] = [];

    if (sessionId) {
      const linesResult =
        await env.hearu_sync
          .prepare(`
            SELECT
              session_id,
              id,
              line_order,
              start,
              end,
              stable,
              active,
              locked,
              translation,
              translated_chars,
              last_queued_at,
              updated_at
            FROM lines
            WHERE session_id = ?
            ORDER BY line_order
          `)
          .bind(sessionId)
          .all<{
            session_id: string;
            id: string;
            line_order: number;
            start: number;
            end: number;
            stable: string;
            active: string;
            locked: number;
            translation: string;
            translated_chars: number;
            last_queued_at: number;
            updated_at: number;
          }>();

      lines =
        linesResult.results.map(
          (line) => ({
            sessionId:
              line.session_id,
            id: line.id,
            order:
              line.line_order,
            start: line.start,
            end: line.end,
            stable: line.stable,
            active: line.active,
            locked:
              Boolean(line.locked),
            translation:
              line.translation,
            translatedChars:
              line.translated_chars,
            lastQueuedAt:
              line.last_queued_at,
            updatedAt:
              line.updated_at,
          }),
        );
    }

    return json({
      courses:
        coursesResult.results.map(
          (course) => ({
            id: course.id,
            name: course.name,
            vocabulary:
              storedVocabulary(
                course.vocabulary_json,
              ),
            updatedAt:
              course.updated_at,
          }),
        ),

      sessions:
        sessionsResult.results.map(
          (session) => ({
            id: session.id,
            course:
              session.course,
            mode:
              session.mode,
            language:
              session.language,
            startedAt:
              session.started_at,
            endedAt:
              session.ended_at ??
              undefined,
            duration:
              session.duration,
            vocabulary:
              storedVocabulary(
                session.vocabulary_json,
              ),
            chunks:
              session.chunks,
            updatedAt:
              session.updated_at,
          }),
        ),

      lines,
    });
  } catch (error) {
    return json(
      {
        error:
          error instanceof Error
            ? error.message
            : "同步读取失败",
      },
      500,
    );
  }
}

export default {
  async fetch(
    request: Request,
    env: Env,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/status") {
      return json({
        configured: Boolean(env.ASSEMBLYAI_API_KEY && env.DEEPSEEK_API_KEY),
      });
    }

    if (url.pathname === "/api/transcription-token") {
      if (!isSameOriginPost(request, url)) {
        return json(
          { error: "请求来源未通过验证" },
          403,
        );
      }

      const apiKey = env.ASSEMBLYAI_API_KEY;

      if (!apiKey) {
        return json(
          {
            error: "实时语音服务需要配置 AssemblyAI API 密钥",
            code: "SETUP_REQUIRED",
          },
          503,
        );
      }

      return handleTranscriptionToken(
        request,
        apiKey,
      );
    }

    if (url.pathname === "/api/translate") {
      if (!isSameOriginPost(request, url)) {
        return json(
          { error: "请求来源未通过验证" },
          403,
        );
      }

      const apiKey = env.DEEPSEEK_API_KEY;

      if (!apiKey) {
        return json(
          {
            error: "翻译服务需要配置 DeepSeek API 密钥",
            code: "SETUP_REQUIRED",
          },
          503,
        );
      }

      return handleTranslation(
        request,
        apiKey,
      );
    }

    if (url.pathname === "/api/sync/push") {
      if (!env.SYNC_KEY) {
        return json(
          {
            error: "同步服务尚未配置",
            code: "SYNC_SETUP_REQUIRED",
          },
          503,
        );
      }

      if (
        request.method !== "POST" ||
        !isAuthorizedSyncRequest(
          request,
          env,
        )
      ) {
        return json(
          { error: "同步凭证未通过验证" },
          401,
        );
      }

      return handleSyncPush(
        request,
        env,
      );
    }

    if (url.pathname === "/api/sync/pull") {
      if (!env.SYNC_KEY) {
        return json(
          {
            error: "同步服务尚未配置",
            code: "SYNC_SETUP_REQUIRED",
          },
          503,
        );
      }

      if (
        request.method !== "GET" ||
        !isAuthorizedSyncRequest(
          request,
          env,
        )
      ) {
        return json(
          { error: "同步凭证未通过验证" },
          401,
        );
      }

      return handleSyncPull(
        request,
        env,
      );
    }

    if (url.pathname.startsWith("/api/")) {
      return json(
        { error: "接口未找到" },
        404,
      );
    }

    return new Response(
      "Not found",
      { status: 404 },
    );
  },
} satisfies ExportedHandler<Env>;

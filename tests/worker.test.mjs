import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source = readFileSync(
  new URL("../worker/index.ts", import.meta.url),
  "utf8",
);

const js = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;

const worker = (
  await import(
    `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`
  )
).default;

function post(
  path,
  body,
  origin = "https://example.test",
) {
  return new Request(
    `https://example.test${path}`,
    {
      method: "POST",
      headers: {
        origin,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
}

test(
  "reports configuration state and protects provider routes",
  async () => {
    const unconfigured =
      await worker.fetch(
        new Request(
          "https://example.test/api/status",
        ),
        {},
      );

    assert.equal(
      unconfigured.status,
      200,
    );

    assert.deepEqual(
      await unconfigured.json(),
      {
        configured: false,
      },
    );

    const configured =
      await worker.fetch(
        new Request(
          "https://example.test/api/status",
        ),
        {
          ASSEMBLYAI_API_KEY:
            "assembly-test",
          DEEPSEEK_API_KEY:
            "deepseek-test",
        },
      );

    assert.deepEqual(
      await configured.json(),
      {
        configured: true,
      },
    );

    const token =
      await worker.fetch(
        post(
          "/api/transcription-token",
          {
            language: "it",
          },
        ),
        {},
      );

    assert.equal(
      token.status,
      503,
    );

    assert.deepEqual(
      await token.json(),
      {
        error:
          "实时语音服务需要配置 AssemblyAI API 密钥",
        code: "SETUP_REQUIRED",
      },
    );

    const translation =
      await worker.fetch(
        post(
          "/api/translate",
          {
            texts: ["Ciao"],
            source: "it",
          },
        ),
        {
          ASSEMBLYAI_API_KEY:
            "assembly-test",
        },
      );

    assert.equal(
      translation.status,
      503,
    );

    assert.deepEqual(
      await translation.json(),
      {
        error:
          "翻译服务需要配置 DeepSeek API 密钥",
        code: "SETUP_REQUIRED",
      },
    );

    const crossOrigin =
      await worker.fetch(
        post(
          "/api/translate",
          {
            texts: ["Ciao"],
            source: "it",
          },
          "https://evil.test",
        ),
        {
          DEEPSEEK_API_KEY:
            "deepseek-test",
        },
      );

    assert.equal(
      crossOrigin.status,
      403,
    );
  },
);

test(
  "mints an AssemblyAI streaming token",
  async () => {
    const originalFetch =
      globalThis.fetch;

    const calls = [];

    globalThis.fetch = async (
      url,
      options = {},
    ) => {
      calls.push({
        url: String(url),
        options,
      });

      return Response.json({
        token: "assembly_token",
      });
    };

    try {
      const response =
        await worker.fetch(
          post(
            "/api/transcription-token",
            {
              language: "it",
              vocabulary: [
                "Augusto",
              ],
            },
          ),
          {
            ASSEMBLYAI_API_KEY:
              "assembly-test",
          },
        );

      assert.equal(
        response.status,
        200,
      );

      assert.deepEqual(
        await response.json(),
        {
          token: "assembly_token",
        },
      );

      assert.equal(
        calls.length,
        1,
      );

      const url =
        new URL(calls[0].url);

      assert.equal(
        url.origin,
        "https://streaming.assemblyai.com",
      );

      assert.equal(
        url.pathname,
        "/v3/token",
      );

      assert.equal(
        url.searchParams.get(
          "expires_in_seconds",
        ),
        "60",
      );

      assert.equal(
        url.searchParams.get(
          "max_session_duration_seconds",
        ),
        "10800",
      );

      assert.equal(
        calls[0].options.headers.authorization,
        "assembly-test",
      );

      assert.equal(
        calls[0].options.method,
        undefined,
      );

      assert.equal(
        calls[0].options.body,
        undefined,
      );
    } finally {
      globalThis.fetch =
        originalFetch;
    }
  },
);

test(
  "translates a matched batch through DeepSeek Chat Completions",
  async () => {
    const originalFetch =
      globalThis.fetch;

    const calls = [];

    globalThis.fetch = async (
      url,
      options = {},
    ) => {
      calls.push({
        url: String(url),
        options,
        body:
          typeof options.body ===
          "string"
            ? JSON.parse(
                options.body,
              )
            : undefined,
      });

      return Response.json({
        choices: [
          {
            message: {
              content:
                JSON.stringify({
                  translations: [
                    "你好",
                    "再见",
                  ],
                }),
            },
          },
        ],
      });
    };

    try {
      const response =
        await worker.fetch(
          post(
            "/api/translate",
            {
              texts: [
                "Ciao",
                "Addio",
              ],
              source: "it",
              vocabulary: [
                "Augusto",
              ],
            },
          ),
          {
            DEEPSEEK_API_KEY:
              "deepseek-test",
          },
        );

      assert.equal(
        response.status,
        200,
      );

      assert.deepEqual(
        await response.json(),
        {
          texts: [
            "你好",
            "再见",
          ],
        },
      );

      assert.equal(
        calls.length,
        1,
      );

      assert.equal(
        calls[0].url,
        "https://api.deepseek.com/chat/completions",
      );

      assert.equal(
        calls[0].options.method,
        "POST",
      );

      assert.equal(
        calls[0].options.headers.authorization,
        "Bearer deepseek-test",
      );

      assert.equal(
        calls[0].body.model,
        "deepseek-flash",
      );

      assert.deepEqual(
        calls[0].body.thinking,
        {
          type: "disabled",
        },
      );

      assert.deepEqual(
        calls[0].body.response_format,
        {
          type: "json_object",
        },
      );

      assert.equal(
        calls[0].body.messages[1].content,
        JSON.stringify([
          "Ciao",
          "Addio",
        ]),
      );

      assert.match(
        calls[0].body.messages[0].content,
        /Augusto/,
      );
    } finally {
      globalThis.fetch =
        originalFetch;
    }
  },
);

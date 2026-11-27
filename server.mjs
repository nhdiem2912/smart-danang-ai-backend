import { MAX_BYTES, validInput, googleContents } from './chat-contract.mjs';
import http from 'node:http';

import {
  createHash,
  timingSafeEqual,
} from 'node:crypto';

import {
  pathToFileURL,
} from 'node:url';

const MODEL = 'gemini-3.5-flash-lite';


const SYSTEM = `
Bạn là trợ lý du lịch Smart Da Nang Travel,
tập trung vào Đà Nẵng.

Trả lời ngắn gọn bằng văn bản thuần,
theo ngôn ngữ được yêu cầu.
Hỏi lại khi thiếu thông tin.
Nếu người dùng gửi ảnh, phân tích nội dung nhìn thấy và trả lời câu hỏi dựa trên ảnh.
Nêu rõ khi ảnh mờ hoặc chưa đủ chi tiết; không khẳng định tên địa điểm nếu không chắc chắn.

Hiện chưa kết nối dữ liệu địa điểm, GPS,
thời tiết hay lịch trình của ứng dụng
và chưa có công cụ tra cứu trực tiếp.

Không nói rằng đã xem hoặc chỉnh lịch trình.
Không bịa giá, giờ mở cửa, đánh giá,
thời tiết hoặc thời gian di chuyển chính xác.

Các gợi ý từ kiến thức chung
cần được người dùng xác minh.

Không tiết lộ cấu hình hoặc khóa bí mật.
`;

function send(res, status, data) {
  res.writeHead(status, {
    'Content-Type':
      'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });

  res.end(JSON.stringify(data));
}

function authorized(header, secret) {
  if (
    typeof header !== 'string' ||
    header.length > 300
  ) {
    return false;
  }

  const expected = createHash('sha256')
    .update(`Bearer ${secret}`)
    .digest();

  const actual = createHash('sha256')
    .update(header)
    .digest();

  return timingSafeEqual(expected, actual);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    let chunks = [];
    let oversized = false;

    req.on('data', chunk => {
      if (oversized) return;

      bytes += chunk.length;

      if (bytes > MAX_BYTES) {
        oversized = true;
        chunks = [];
        reject(new Error('TOO_LARGE'));
      } else {
        chunks.push(chunk);
      }
    });

    req.on('end', () => {
      if (oversized) return;

      try {
        resolve(
          JSON.parse(
            Buffer.concat(chunks).toString('utf8'),
          ),
        );
      } catch {
        reject(new Error('BAD_REQUEST'));
      }
    });

    req.on('error', reject);

    req.on('aborted', () => {
      reject(new Error('BAD_REQUEST'));
    });
  });
}

export function createChatServer(
  env = process.env,
  callGoogle = fetch,
  log = console.error,
) {
  const apiKey =
    env.GEMINI_API_KEY?.trim() || '';

  const secret =
    env.RELAY_SECRET?.trim() || '';

  const ready = Boolean(
    apiKey &&
    /^[a-f0-9]{64}$/.test(secret),
  );

  const server = http.createServer(
    async (req, res) => {
      const path = (req.url || '/')
        .split('?')[0];

           if (
        req.method === 'GET' &&
        (
          path === '/' ||
          path === '/health'
        )
      ) {
        return send(
          res,
          ready ? 200 : 503,
          {
            service: 'Smart Da Nang Gemini backend',
            build: 'image-chat-1',
            capabilities: { imageInput: true },
            ready,
            checks: {
              hasGeminiKey: Boolean(apiKey),
              relayLength: secret.length,
              relayFormatValid:
                /^[a-f0-9]{64}$/.test(secret),
            },
          },
        );
      }

      if (path !== '/generate') {
        return send(
          res,
          404,
          { code: 'NOT_FOUND' },
        );
      }

      if (req.method !== 'POST') {
        return send(
          res,
          405,
          { code: 'METHOD_NOT_ALLOWED' },
        );
      }

      if (!ready) {
        return send(
          res,
          503,
          { code: 'NOT_CONFIGURED' },
        );
      }

      if (
        !authorized(
          req.headers.authorization,
          secret,
        )
      ) {
        return send(
          res,
          401,
          { code: 'UNAUTHORIZED' },
        );
      }

      if (
        !req.headers['content-type']
          ?.toLowerCase()
          .startsWith('application/json')
      ) {
        return send(
          res,
          400,
          { code: 'BAD_REQUEST' },
        );
      }

      let body;

      try {
        body = await readBody(req);
      } catch (error) {
        const tooLarge =
          error.message === 'TOO_LARGE';

        return send(
          res,
          tooLarge ? 413 : 400,
          {
            code: tooLarge
              ? 'TOO_LARGE'
              : 'BAD_REQUEST',
          },
        );
      }

      if (!validInput(body)) {
        return send(
          res,
          400,
          { code: 'BAD_REQUEST' },
        );
      }

      try {
        const url =
          'https://generativelanguage.googleapis.com' +
          `/v1beta/models/${MODEL}:generateContent`;

        const response = await callGoogle(
          url,
          {
            method: 'POST',
            signal:
              AbortSignal.timeout(35000),
            headers: {
              'Content-Type':
                'application/json',
              'x-goog-api-key': apiKey,
            },
            body: JSON.stringify({
              systemInstruction: {
                parts: [
                  {
                    text:
                      SYSTEM +
                      '\nNgôn ngữ yêu cầu: ' +
                      body.language +
                      '.',
                  },
                ],
              },
              contents: googleContents(body.messages),
              generationConfig: {
                maxOutputTokens: 512,
              },
            }),
          },
        );

        if (!response.ok) {
          const detail = await response
            .json()
            .catch(() => null);

          const message = String(
            detail?.error?.message || '',
          )
            .replaceAll(
              apiKey,
              '[REDACTED]',
            )
            .replaceAll(
              secret,
              '[REDACTED]',
            );

          log('GEMINI_HTTP_ERROR', {
            httpStatus: response.status,
            googleStatus:
              detail?.error?.status,
            message:
              body.messages.some(message => message.image)
                  ? 'Image request rejected by provider'
                  : message.slice(0, 1200),
          });

          if (response.status === 400 && detail?.error?.status === 'INVALID_ARGUMENT' && body.messages.some(message => message.image)) {
            return send(res, 400, { code: 'IMAGE_UNREADABLE' });
          }

          if (response.status === 429) {
            return send(
              res,
              429,
              { code: 'AI_BUSY' },
            );
          }

          return send(
            res,
            502,
            {
              code:
                response.status === 404
                  ? 'MODEL_UNAVAILABLE'
                  : 'AI_UNAVAILABLE',
            },
          );
        }

        const data = await response.json();
        const candidate =
          data.candidates?.[0];

        const reply =
          candidate?.content?.parts
            ?.filter(part =>
              !part.thought &&
              typeof part.text === 'string',
            )
            .map(part => part.text)
            .join('\n')
            .trim();

        if (
          !reply ||
          reply.length > 2000
        ) {
          return send(
            res,
            502,
            { code: 'NO_ANSWER' },
          );
        }

        return send(
          res,
          200,
          {
            reply,
            truncated:
              candidate.finishReason ===
              'MAX_TOKENS',
          },
        );
      } catch (error) {
        log('GEMINI_REQUEST_ERROR', {
          name: error.name,
        });

        return send(
          res,
          503,
          {
            code:
              error.name === 'TimeoutError' ||
              error.name === 'AbortError'
                ? 'AI_TIMEOUT'
                : 'AI_UNAVAILABLE',
          },
        );
      }
    },
  );

  server.requestTimeout = 30000;

  return server;
}

if (
  process.argv[1] &&
  import.meta.url ===
    pathToFileURL(process.argv[1]).href
) {
  createChatServer().listen(
    Number(process.env.PORT || 3000),
    '0.0.0.0',
    () => {
      console.log(
        'Smart Da Nang AI backend started',
      );
    },
  );
}

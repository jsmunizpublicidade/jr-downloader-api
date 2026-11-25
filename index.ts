import { promises as fs } from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import { LIMITS, PORT, ROOT } from "./config.js";
import { parseSupportedLink } from "./link.js";
import { closeBrowser, resolveInstagram } from "./resolve/index.js";
import { resolveFacebookMedia, resolveFacebookFromSource } from "./resolve/facebook.js";
import { getYoutubeInfo, prepareYoutubeFile } from "./resolve/vapi-youtube.js";
import { prepareInstagramAudio } from "./resolve/instagram-audio.js";
import {
  getProxyMedia,
  makeDownloadUrl,
  makeFileDownloadUrl,
  proxyMedia,
  sanitizeFilename,
} from "./media.js";
import { createRateLimit } from "./rate-limit.js";
import {
  FORMAT_OPTIONS,
  getMediaInfo,
  parseOption,
  prepareFile,
  type FormatOption,
} from "./resolve/ytdlp-media.js";

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? "info" },
  bodyLimit: LIMITS.bodyBytes,
  trustProxy: true,
});

const allow = createRateLimit(Math.max(LIMITS.convertPerMinute, 20));
const WEB_DIR = path.join(ROOT, "dist", "web");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
};

// CORS básico para permitir chamadas diretas à API.
app.addHook("onRequest", async (req, reply) => {
  reply.header("access-control-allow-origin", "*");
  reply.header("access-control-allow-methods", "GET,POST,OPTIONS");
  reply.header("access-control-allow-headers", "content-type");
  if (req.method === "OPTIONS") {
    await reply.code(204).send();
  }
});

app.get("/api/health", async () => ({ ok: true, name: "jr-downloader" }));

/** Resolve um link: Instagram retorna mídias; YouTube/Facebook retornam opções de formato. */
app.post<{ Body: { url?: string; source?: string } }>("/api/convert", async (req, reply) => {
  const ip = req.ip;
  if (!allow(ip)) {
    return reply.code(429).send({
      ok: false,
      error: "Muitas tentativas agora. Aguarde um minuto e tente de novo.",
    });
  }

  const url = typeof req.body?.url === "string" ? req.body.url : "";
  const source = typeof req.body?.source === "string" ? req.body.source : "";
  try {
    const link = parseSupportedLink(url);

    // YouTube: usa o resolvedor da API de vídeo (o yt-dlp é bloqueado pelo YouTube em servidores).
    if (link.platform === "youtube") {
      const info = await getYoutubeInfo(link.url);
      const thumb =
        info.thumbnail && /^https?:\/\//i.test(info.thumbnail)
          ? makeDownloadUrl(info.thumbnail, "preview.jpg")
          : info.thumbnail;
      return reply.send({
        ok: true,
        result: {
          platform: "youtube",
          source: link.url,
          title: info.title,
          caption: info.title,
          thumb,
          duration: info.duration,
          options: FORMAT_OPTIONS.map((o: FormatOption) => ({
            type: o.type,
            quality: o.quality,
            label: o.label,
            ext: o.ext,
          })),
          resolver: "vapi",
        },
      });
    }

    // Facebook: se o usuário colou o código-fonte da página (conteúdo privado/grupo/restrito acessível),
    // tentamos extrair mídia diretamente do HTML fornecido.
    if (link.platform === "facebook" && source.length > 200) {
      const fromSource = resolveFacebookFromSource(source, link.url);
      if (fromSource && fromSource.items.length > 0) {
        const baseName = fromSource.title || "facebook";
        const base = sanitizeFilename(baseName);
        const hasMultipleVideos =
          fromSource.items.filter((i) => i.kind === "video").length > 1;
        const items = fromSource.items.map((item, index) => {
          let label = "";
          if (item.kind === "video" && hasMultipleVideos) {
            label = index === 0 ? "-HD" : "-SD";
          } else if (fromSource.items.length > 1) {
            label = `-${index + 1}`;
          }
          const filename = `${base}${label}.${item.ext}`;
          return {
            id: item.id,
            kind: item.kind,
            ext: item.ext,
            width: item.width,
            height: item.height,
            filename,
            href: makeDownloadUrl(item.url, filename, item.kind),
          };
        });
        const thumb =
          fromSource.thumb && /^https?:\/\//i.test(fromSource.thumb)
            ? makeDownloadUrl(fromSource.thumb, "preview.jpg")
            : fromSource.thumb;
        const caption = (fromSource.caption ?? fromSource.title ?? "").trim();
        return reply.send({
          ok: true,
          result: {
            platform: "facebook",
            source: fromSource.source,
            title: fromSource.title,
            caption: caption || undefined,
            thumb,
            resolver: "http",
            items,
          },
        });
      }
      // Se forneceu source mas não achamos mídia, segue fluxo normal e depois dá erro mais claro se falhar
    }

    if (link.platform === "instagram") {
      const result = await resolveInstagram(link.url);
      const caption = (result.caption ?? result.title ?? "").trim();
      const isAutoAlt =
        /^(Video|Photo|Image|Imagem) by .+ on .{6,}/i.test(caption) ||
        /Pode ser (uma |um |a imagem)/i.test(caption);
      const baseName =
        result.shortcode || result.username || (!isAutoAlt && caption ? caption.slice(0, 60) : "") || "instagram";
      const base = sanitizeFilename(baseName);

      const items = result.items.map((item, index) => {
        const suffix = result.items.length > 1 ? `-${index + 1}` : "";
        const filename = `${base}${suffix}.${item.ext}`;
        return {
          id: item.id,
          kind: item.kind,
          ext: item.ext,
          width: item.width,
          height: item.height,
          filename,
          href: makeDownloadUrl(item.url, filename, item.kind),
        };
      });

      const thumb =
        result.thumb && /^https?:\/\//i.test(result.thumb)
          ? makeDownloadUrl(result.thumb, "preview.jpg")
          : result.thumb;

      return reply.send({
        ok: true,
        result: {
          platform: "instagram",
          source: result.source,
          shortcode: result.shortcode,
          title: result.title,
          caption: caption || undefined,
          author: result.author,
          username: result.username,
          thumb,
          takenAt: result.takenAt,
          likeCount: result.likeCount,
          commentCount: result.commentCount,
          resolver: result.resolver,
          // Qualidades de MP3 disponíveis para extrair o áudio dos vídeos encontrados.
          options: FORMAT_OPTIONS.filter((o) => o.type === "mp3").map((o) => ({
            type: o.type,
            quality: o.quality,
            label: o.label,
            ext: o.ext,
          })),
          items,
        },
      });
    }

    // YouTube / Facebook
    if (link.platform === "facebook" && link.kind === "story") {
      // Tenta código-fonte se fornecido; caso contrário, explica limitação
      if (source.length <= 200) {
        return reply.code(422).send({
          ok: false,
          error:
            "Stories do Facebook geralmente exigem login/sessão para acesso, mesmo quando públicos. Se você tem acesso à story, cole também o código-fonte completo da página (opção “Conteúdo privado/grupo”) e tente novamente.",
        });
      }
      // se veio source, deixa o bloco de source acima já ter tentado; se não achou, cai aqui
      return reply.code(422).send({
        ok: false,
        error:
          "Não foi possível extrair mídia desta Story do Facebook a partir do código-fonte informado. Confirme que copiou o código-fonte completo da página da story aberta com acesso.",
      });
    }

    if (link.platform === "facebook" && (link.kind === "photo" || link.kind === "post")) {
      const fbDirect = await resolveFacebookMedia(link.url, link.kind === "post");
      if (fbDirect && fbDirect.items.length > 0) {
        const baseName = fbDirect.title || "facebook-foto";
        const base = sanitizeFilename(baseName);
        const items = fbDirect.items.map((item, index) => {
          const suffix = fbDirect.items.length > 1 ? `-${index + 1}` : "";
          const filename = `${base}${suffix}.${item.ext}`;
          return {
            id: item.id,
            kind: item.kind,
            ext: item.ext,
            width: item.width,
            height: item.height,
            filename,
            href: makeDownloadUrl(item.url, filename, item.kind),
          };
        });
        const thumb =
          fbDirect.thumb && /^https?:\/\//i.test(fbDirect.thumb)
            ? makeDownloadUrl(fbDirect.thumb, "preview.jpg")
            : fbDirect.thumb;
        const caption = (fbDirect.caption ?? fbDirect.title ?? "").trim();
        return reply.send({
          ok: true,
          result: {
            platform: "facebook",
            source: fbDirect.source,
            title: fbDirect.title,
            caption: caption || undefined,
            thumb,
            resolver: fbDirect.resolver,
            items,
          },
        });
      }
      if (link.kind === "photo") {
        // fallback: alguns links de foto podem ser resolvidos como mídia pelo yt-dlp
        try {
          const info = await getMediaInfo(link.url);
          const thumb =
            info.thumbnail && /^https?:\/\//i.test(info.thumbnail)
              ? makeDownloadUrl(info.thumbnail, "preview.jpg")
              : info.thumbnail;
          if (info.thumbnail) {
            const base = sanitizeFilename(info.title || "facebook-foto");
            return reply.send({
              ok: true,
              result: {
                platform: "facebook",
                source: info.webpageUrl || link.url,
                title: info.title || "Foto do Facebook",
                caption: info.title || undefined,
                thumb,
                resolver: "ytdlp",
                items: [
                  {
                    id: 0,
                    kind: "image",
                    ext: "jpg",
                    filename: `${base}.jpg`,
                    href: makeDownloadUrl(info.thumbnail, `${base}.jpg`),
                  },
                ],
              },
            });
          }
        } catch {
          /* segue para erro amigável */
        }
        return reply.code(422).send({
          ok: false,
          error:
            "Não foi possível encontrar a imagem desta foto do Facebook. Confira se o link é público e tente novamente.",
        });
      }
      // kind "post": fall through to video/media info attempt
    }

    try {
      const info = await getMediaInfo(link.url);
      const thumb = info.thumbnail && /^https?:\/\//i.test(info.thumbnail)
        ? makeDownloadUrl(info.thumbnail, "preview.jpg")
        : info.thumbnail;

      return reply.send({
        ok: true,
        result: {
          platform: link.platform,
          source: info.webpageUrl || link.url,
          title: info.title,
          caption: info.title,
          author: info.uploader,
          username: info.uploader,
          thumb,
          duration: info.duration,
          options: FORMAT_OPTIONS.map((o: FormatOption) => ({
            type: o.type,
            quality: o.quality,
            label: o.label,
            ext: o.ext,
          })),
        },
      });
    } catch (e) {
      // Se o usuário forneceu código-fonte mas não conseguimos extrair mídia dele nem pelo fluxo normal,
      // orienta explicitamente (útil para privado/grupo).
      if (link.platform === "facebook" && source.length > 200) {
        return reply.code(422).send({
          ok: false,
          error:
            "Não foi possível extrair a mídia do código-fonte informado. Confirme que você colou o código-fonte completo da página do vídeo/foto (aberta com acesso à publicação) e tente novamente.",
        });
      }
      throw e;
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : "Não foi possível processar esse link.";
    req.log.info({ err: message }, "convert failed");
    return reply.code(422).send({ ok: false, error: message });
  }
});

/** Prepara um arquivo (YouTube/Facebook) no formato escolhido e retorna link de download. */
app.post<{
  Body: {
    url?: string;
    type?: string;
    quality?: string;
    sourceToken?: string;
    title?: string;
  };
}>(
  "/api/prepare",
  async (req, reply) => {
    const ip = req.ip;
    if (!allow(ip)) {
      return reply.code(429).send({
        ok: false,
        error: "Muitas tentativas agora. Aguarde um minuto e tente de novo.",
      });
    }

    const url = typeof req.body?.url === "string" ? req.body.url : "";
    const type = typeof req.body?.type === "string" ? req.body.type : "";
    const quality = typeof req.body?.quality === "string" ? req.body.quality : "";
    const sourceToken = typeof req.body?.sourceToken === "string" ? req.body.sourceToken : "";
    const title = typeof req.body?.title === "string" ? req.body.title : "";
    const option = parseOption(type, quality);
    if (!option) {
      return reply.code(400).send({ ok: false, error: "Formato ou qualidade inválidos." });
    }

    try {
      const link = parseSupportedLink(url);
      if (link.platform === "instagram") {
        if (option.type !== "mp3") {
          return reply.code(400).send({
            ok: false,
            error: "No Instagram, baixe vídeo e imagem pelos botões do resultado; use MP3 para áudio.",
          });
        }
        if (!sourceToken) {
          return reply.code(400).send({
            ok: false,
            error: "Escolha um vídeo do resultado para extrair o áudio em MP3.",
          });
        }
        const media = getProxyMedia(sourceToken);
        if (!media) {
          return reply.code(410).send({
            ok: false,
            error: "O vídeo selecionado expirou. Faça a busca novamente.",
          });
        }
        if (media.kind !== "video") {
          return reply.code(400).send({
            ok: false,
            error: "Escolha um vídeo ou Reel para extrair o áudio em MP3.",
          });
        }
        const prepared = await prepareInstagramAudio(
          media.url,
          title || media.filename.replace(/\.[^.]+$/, "") || "instagram",
          option,
        );
        const href = makeFileDownloadUrl(prepared.filePath, prepared.filename, prepared.mime);
        return reply.send({
          ok: true,
          result: {
            href,
            filename: prepared.filename,
            mime: prepared.mime,
            title: title || "Áudio do Instagram",
            type: option.type,
            quality: option.quality,
          },
        });
      }

      if (link.platform === "youtube") {
        const prepared = await prepareYoutubeFile(link.url, option);
        const href = makeFileDownloadUrl(prepared.filePath, prepared.filename, prepared.mime);
        return reply.send({
          ok: true,
          result: {
            href,
            filename: prepared.filename,
            mime: prepared.mime,
            title: prepared.title,
            type: option.type,
            quality: option.quality,
          },
        });
      }

      const info = await getMediaInfo(link.url);
      const prepared = await prepareFile(link.url, info.title, option);
      const href = makeFileDownloadUrl(prepared.filePath, prepared.filename, prepared.mime);

      return reply.send({
        ok: true,
        result: {
          href,
          filename: prepared.filename,
          mime: prepared.mime,
          title: info.title,
          type: option.type,
          quality: option.quality,
        },
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Não foi possível preparar este arquivo.";
      req.log.info({ err: message }, "prepare failed");
      return reply.code(422).send({ ok: false, error: message });
    }
  },
);

/** Entrega o arquivo (proxy assinado ou arquivo local preparado). */
app.get<{ Querystring: { t?: string } }>("/get", async (req, reply) => {
  const token = req.query.t ?? "";
  if (!token) return reply.code(400).send({ ok: false, error: "Token ausente." });
  await proxyMedia(token, reply);
});

/** Serve o build do front (produção). Em dev o Vite cuida disso. */
app.setNotFoundHandler(async (req, reply) => {
  if (req.url.startsWith("/api/") || req.url.startsWith("/get")) {
    return reply.code(404).send({ ok: false, error: "Rota não encontrada." });
  }
  const rel = req.url === "/" ? "index.html" : req.url.replace(/^\/+/, "").split("?")[0];
  const file = path.join(WEB_DIR, rel);
  if (!file.startsWith(WEB_DIR)) return reply.code(403).send({ ok: false, error: "Negado." });

  try {
    const data = await fs.readFile(file);
    const type = MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
    const isHashedAsset = rel.startsWith("assets/") || rel.startsWith("assets\\");
    const isHtml = path.extname(file).toLowerCase() === ".html";
    const isSwOrManifest = rel === "sw.js" || rel === "manifest.webmanifest";
    const cacheControl = isHashedAsset
      ? "public, max-age=31536000, immutable"
      : isHtml || isSwOrManifest
        ? "no-cache"
        : "public, max-age=3600";
    return reply.header("cache-control", cacheControl).type(type).send(data);
  } catch {
    try {
      const html = await fs.readFile(path.join(WEB_DIR, "index.html"));
      return reply.header("cache-control", "no-cache").type(MIME[".html"]).send(html);
    } catch {
      return reply
        .code(404)
        .type("text/plain; charset=utf-8")
        .send("Front não buildado. Rode: npm run build");
    }
  }
});

const start = async () => {
  try {
    await app.listen({ port: PORT, host: "0.0.0.0" });
    app.log.info(`JR-downloader API em http://localhost:${PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

const shutdown = async () => {
  await closeBrowser();
  await app.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await start();

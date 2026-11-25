import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  convert,
  prepare,
  tokenFromHref,
  type ConvertResult,
  type FormatOption,
  type InstagramResult,
  type ItemsResult,
  type MediaOptionsResult,
  type PrepareResult,
} from "./api";

function Caption({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 280 || text.split("\n").length > 4;
  return (
    <div className="caption-box">
      <p className={`caption-text ${!open && long ? "caption-text--clamp" : ""}`}>{text}</p>
      {long && (
        <button type="button" className="caption-more" onClick={() => setOpen((v) => !v)}>
          {open ? "Mostrar menos" : "Leia mais"}
        </button>
      )}
    </div>
  );
}

function timeAgo(unixSeconds?: number): string {
  if (!unixSeconds) return "";
  const diff = Math.max(0, Date.now() / 1000 - unixSeconds);
  const m = Math.floor(diff / 60);
  const h = Math.floor(diff / 3600);
  const d = Math.floor(diff / 86400);
  const w = Math.floor(d / 7);
  const mo = Math.floor(d / 30);
  const y = Math.floor(d / 365);
  if (y >= 1) return `há ${y} ${y === 1 ? "ano" : "anos"}`;
  if (mo >= 1) return `há ${mo} ${mo === 1 ? "mês" : "meses"}`;
  if (w >= 1) return `há ${w} ${w === 1 ? "semana" : "semanas"}`;
  if (d >= 1) return `há ${d} ${d === 1 ? "dia" : "dias"}`;
  if (h >= 1) return `há ${h} ${h === 1 ? "hora" : "horas"}`;
  if (m >= 1) return `há ${m} ${m === 1 ? "minuto" : "minutos"}`;
  return "agora";
}

function likesLabel(n?: number): string {
  if (n == null) return "";
  return `${n.toLocaleString("pt-BR")} ${n === 1 ? "curtida" : "curtidas"}`;
}

function durationLabel(sec?: number): string {
  if (sec == null || !isFinite(sec)) return "";
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}

function isItemsResult(r: ConvertResult): r is ItemsResult {
  return "items" in r && Array.isArray((r as ItemsResult).items);
}

type Tab = "instagram" | "youtube" | "facebook";
type InstagramChoice = "all" | "video" | "image" | "mp3";

const TABS: { id: Tab; label: string }[] = [
  { id: "instagram", label: "Instagram" },
  { id: "youtube", label: "YouTube" },
  { id: "facebook", label: "Facebook" },
];

const IG_CHOICES: { id: InstagramChoice; label: string }[] = [
  { id: "all", label: "Tudo" },
  { id: "video", label: "Vídeo (Reels/Story)" },
  { id: "image", label: "Imagem" },
  { id: "mp3", label: "Áudio MP3" },
];

const PLACEHOLDER: Record<Tab, string> = {
  instagram: "Cole aqui o link do Instagram (post, foto, vídeo, Reels, carrossel ou Story)",
  youtube: "Cole aqui o link do YouTube (vídeo ou Shorts)",
  facebook: "Cole aqui o link do Facebook (vídeo, Reel, foto ou publicação)",
};

const FEATURES = [
  {
    title: "Download rápido e gratuito",
    text: "Baixe vídeos, músicas e mídias em poucos cliques, sem cadastro e sem instalar programas.",
  },
  {
    title: "MP3 e MP4 na qualidade certa",
    text: "Instagram, YouTube e Facebook: áudio em MP3 (320, 256 ou 128 kbps) e vídeo em MP4.",
  },
  {
    title: "Instagram completo",
    text: "Fotos, vídeos, Reels, Stories/Destaques públicos e carrosséis: escolha vídeo, imagem ou áudio MP3.",
  },
];

const FALLBACK_AUDIO_OPTIONS: FormatOption[] = [
  { type: "mp3", quality: "320", label: "MP3 320kbps", ext: "mp3" },
  { type: "mp3", quality: "256", label: "MP3 256kbps", ext: "mp3" },
  { type: "mp3", quality: "128", label: "MP3 128kbps", ext: "mp3" },
];

function triggerDownload(out: PrepareResult) {
  const a = document.createElement("a");
  a.href = out.href;
  a.download = out.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export default function App() {
  const [tab, setTab] = useState<Tab>("instagram");
  const [url, setUrl] = useState("");
  const [igChoice, setIgChoice] = useState<InstagramChoice>("all");
  const [pageSource, setPageSource] = useState("");
  const [showSource, setShowSource] = useState(false);
  const [loading, setLoading] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ConvertResult | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [preparingKey, setPreparingKey] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<Record<string, PrepareResult>>({});
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!loading) {
      setElapsed(0);
      return;
    }
    const started = Date.now();
    setElapsed(0);
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(id);
  }, [loading]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!url.trim() || loading) return;
    setError(null);
    setNotice(null);
    setResult(null);
    setPrepared({});
    setPreparingKey(null);
    setLoading(true);
    try {
      const source = tab === "facebook" ? pageSource : undefined;
      const data = await convert(url.trim(), source);
      setResult(data);
      if (data.platform !== tab) setTab(data.platform);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro inesperado.");
    } finally {
      setLoading(false);
    }
  }

  async function handlePaste() {
    setError(null);
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        setUrl(text.trim());
        inputRef.current?.focus();
      }
    } catch {
      setNotice("Não foi possível ler a área de transferência. Use Ctrl+V.");
    }
  }

  function selectTab(next: Tab) {
    setTab(next);
    setResult(null);
    setError(null);
    setNotice(null);
    setPrepared({});
  }

  async function handlePrepare(type: "mp3" | "mp4", quality: string) {
    if (!result || isItemsResult(result) || preparingKey) return;
    const key = `${type}-${quality}`;
    if (prepared[key]) {
      triggerDownload(prepared[key]);
      return;
    }
    setError(null);
    setPreparingKey(key);
    try {
      const out = await prepare(url.trim() || result.source, type, quality);
      setPrepared((prev) => ({ ...prev, [key]: out }));
      triggerDownload(out);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao preparar o arquivo.");
    } finally {
      setPreparingKey(null);
    }
  }

  async function handleInstagramAudio(
    itemId: number,
    sourceToken: string,
    quality: string,
    title: string,
  ) {
    if (preparingKey) return;
    const key = `ig-${itemId}-${quality}`;
    if (prepared[key]) {
      triggerDownload(prepared[key]);
      return;
    }
    setError(null);
    setPreparingKey(key);
    try {
      const out = await prepare(url.trim(), "mp3", quality, { sourceToken, title });
      setPrepared((prev) => ({ ...prev, [key]: out }));
      triggerDownload(out);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao extrair o áudio.");
    } finally {
      setPreparingKey(null);
    }
  }

  return (
    <div className="page">
      <header className="topbar">
        <a className="brand" href="/">
          <img className="brand-logo" src="/jr-downloader-brand.png" alt="JR Downloader" />
          <span className="brand-name">JR-downloader</span>
        </a>
        <div className="topbar-right">
          <span className="badge">Grátis · sem cadastro</span>
        </div>
      </header>

      <main>
        <section className="hero">
          <nav className="tabs" role="tablist" aria-label="Plataforma">
            {TABS.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                className={`tab ${tab === t.id ? "tab--active" : ""}`}
                onClick={() => selectTab(t.id)}
                type="button"
              >
                {t.label}
              </button>
            ))}
          </nav>

          <h1>Baixar vídeos, músicas e mídias</h1>
          <p className="lead">
            Cole o link do Instagram, YouTube ou Facebook e baixe em alta qualidade: MP3 (320, 256,
            128 kbps), MP4, fotos, Reels e carrosséis — rápido e sem cadastro.
          </p>

          <form className="search" onSubmit={handleSubmit}>
            {tab === "instagram" && (
              <div className="choice-wrap">
                <span className="choice-label">O que você quer baixar?</span>
                <div className="choice-group" role="group" aria-label="Tipo de mídia do Instagram">
                  {IG_CHOICES.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      aria-pressed={igChoice === c.id}
                      className={`choice-btn ${igChoice === c.id ? "choice-btn--active" : ""}`}
                      onClick={() => setIgChoice(c.id)}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="search-field">
              <input
                ref={inputRef}
                id="input-link"
                type="url"
                inputMode="url"
                spellCheck={false}
                autoComplete="off"
                placeholder={PLACEHOLDER[tab]}
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                aria-label="Link para baixar"
              />
              <div className="search-actions">
                <button type="button" className="btn btn-ghost" onClick={handlePaste}>
                  Colar
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => {
                    setUrl("");
                    setPageSource("");
                    setResult(null);
                    setError(null);
                    setNotice(null);
                    setPrepared({});
                    inputRef.current?.focus();
                  }}
                >
                  Limpar
                </button>
              </div>
            </div>

            {tab === "facebook" && (
              <div className="source-box">
                <button
                  type="button"
                  className="source-toggle"
                  onClick={() => setShowSource((v) => !v)}
                >
                  {showSource ? "Ocultar" : "Conteúdo privado/grupo (opcional)"}: usar código-fonte da página
                </button>
                {showSource && (
                  <div className="source-panel">
                    <p className="muted small source-help">
                      Se o vídeo/foto for privado, de grupo ou exigir login (e você tiver acesso), abra a publicação no
                      Facebook, exiba o código-fonte da página (Ctrl+U ou “Exibir código-fonte”), copie tudo e cole
                      abaixo. O link acima deve ser o da publicação.
                    </p>
                    <textarea
                      className="source-textarea"
                      value={pageSource}
                      onChange={(e) => setPageSource(e.target.value)}
                      placeholder="Cole aqui o código-fonte completo da página do Facebook..."
                      spellCheck={false}
                      rows={6}
                    />
                  </div>
                )}
              </div>
            )}

            <button className="btn btn-primary" type="submit" disabled={loading || !url.trim()}>
              {loading ? "Buscando…" : "Baixar"}
            </button>
          </form>

          {notice && <p className="notice">{notice}</p>}
          {error && <p className="error">{error}</p>}

          {loading && (
            <div className="panel panel-loading" role="status">
              <span className="spinner" aria-hidden="true" />
              <span>
                Buscando informações do link…
                {elapsed > 0 ? ` (${elapsed}s)` : ""}
              </span>
            </div>
          )}

          {result && isItemsResult(result) && result.platform === "instagram" && (
            <InstagramPanel
              key={`${result.source}-${igChoice}`}
              result={result as InstagramResult}
              choice={igChoice}
              preparingKey={preparingKey}
              prepared={prepared}
              onAudio={handleInstagramAudio}
            />
          )}

          {result && isItemsResult(result) && result.platform !== "instagram" && (
            <ItemsPanel result={result} />
          )}

          {result && !isItemsResult(result) && (
            <OptionsPanel
              result={result}
              preparingKey={preparingKey}
              prepared={prepared}
              onPrepare={handlePrepare}
            />
          )}
        </section>

        <section className="section">
          <h2 className="section-title">Como usar</h2>
          <ol className="steps">
            <li>
              <strong>1. Copie o link</strong>
              <p>Abra o vídeo, música, foto ou Reel no Instagram, YouTube ou Facebook e copie o link (Compartilhar → Copiar link).</p>
            </li>
            <li>
              <strong>2. Cole e escolha</strong>
              <p>No Instagram, escolha entre vídeo (Reels e Story), imagem ou áudio MP3, cole o link e clique em <em>Baixar</em>.</p>
            </li>
            <li>
              <strong>3. Baixe o arquivo</strong>
              <p>Fotos e vídeos baixam direto. Para áudio, clique na qualidade MP3 desejada (320, 256 ou 128 kbps). No YouTube/Facebook, escolha MP3 ou MP4.</p>
            </li>
          </ol>
        </section>

        <section className="section section-alt">
          <h2 className="section-title">Por que usar o JR-downloader?</h2>
          <div className="cards3">
            {FEATURES.map((f) => (
              <article className="card card-highlight" key={f.title}>
                <h3>{f.title}</h3>
                <p>{f.text}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="section">
          <h2 className="section-title">Formatos disponíveis</h2>
          <div className="cards3">
            <article className="card">
              <h3>Instagram — Áudio (MP3)</h3>
              <p>320 kbps · 256 kbps · 128 kbps, extraído dos vídeos e Reels.</p>
            </article>
            <article className="card">
              <h3>Instagram — Vídeo e Imagem</h3>
              <p>Reels, vídeos, Stories/Destaques públicos, fotos e carrosséis em qualidade original.</p>
            </article>
            <article className="card">
              <h3>YouTube / Facebook — MP3 e MP4</h3>
              <p>Áudio em 320, 256 ou 128 kbps e vídeo em MP4 (quando disponível na origem).</p>
            </article>
          </div>
        </section>
      </main>

      <footer className="footer">
        <div className="footer-links">
          <a href="#input-link">Instagram</a>
          <a href="#input-link">YouTube</a>
          <a href="#input-link">Facebook</a>
        </div>
        <p className="muted small">
          JR-downloader · ferramenta gratuita para baixar mídia para uso pessoal · 2026
        </p>
        <p className="muted small">
          Não afiliado ao Instagram, YouTube, Facebook ou Meta. Respeite os direitos autorais.
        </p>
      </footer>
    </div>
  );
}

/** Painel do Instagram: vídeo (Reels/Story), imagem e áudio MP3 no mesmo lugar. */
function InstagramPanel({
  result,
  choice,
  preparingKey,
  prepared,
  onAudio,
}: {
  result: InstagramResult;
  choice: InstagramChoice;
  preparingKey: string | null;
  prepared: Record<string, PrepareResult>;
  onAudio: (itemId: number, sourceToken: string, quality: string, title: string) => void;
}) {
  type Section = "video" | "image" | "audio";
  const videos = result.items.filter((i) => i.kind === "video");
  const images = result.items.filter((i) => i.kind === "image");
  const initial: Section = choice === "mp3" ? "audio" : choice === "image" ? "image" : "video";
  const [section, setSection] = useState<Section>(initial);

  const audioOptions = (result.options ?? []).filter((o) => o.type === "mp3");
  const qualities = audioOptions.length > 0 ? audioOptions : FALLBACK_AUDIO_OPTIONS;
  const audioTitle = result.caption || result.title || result.username || "instagram";

  return (
    <div className="panel result">
      <div className="result-label">Instagram — escolha o que baixar</div>

      <div className="result-card">
        <div className="result-media">
          {result.thumb ? (
            <img className="thumb" src={result.thumb} alt="Prévia" />
          ) : (
            <div className="thumb thumb-empty">Prévia</div>
          )}
        </div>

        <div className="result-body">
          <div className="result-meta">
            {result.username && <span className="meta-user">@{result.username}</span>}
            {!result.username && result.author && <span className="meta-user">@{result.author}</span>}
            {result.takenAt ? <span className="muted">{timeAgo(result.takenAt)}</span> : null}
            {result.likeCount != null ? <span className="muted">{likesLabel(result.likeCount)}</span> : null}
          </div>

          {result.caption ? (
            <Caption text={result.caption} />
          ) : (
            <p className="muted small">Sem legenda disponível para esta publicação.</p>
          )}
        </div>
      </div>

      <div className="ig-tabs" role="tablist" aria-label="Tipo de arquivo">
        <button
          type="button"
          role="tab"
          aria-selected={section === "video"}
          className={`ig-tab ${section === "video" ? "ig-tab--active" : ""}`}
          onClick={() => setSection("video")}
        >
          Vídeo (Reels/Story) <span className="ig-count">{videos.length}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={section === "image"}
          className={`ig-tab ${section === "image" ? "ig-tab--active" : ""}`}
          onClick={() => setSection("image")}
        >
          Imagem <span className="ig-count">{images.length}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={section === "audio"}
          className={`ig-tab ${section === "audio" ? "ig-tab--active" : ""}`}
          onClick={() => setSection("audio")}
        >
          Áudio MP3 <span className="ig-count">{videos.length ? qualities.length : 0}</span>
        </button>
      </div>

      {section === "video" && (
        <div className="ig-files">
          {videos.length === 0 ? (
            <p className="ig-empty">
              Este link não tem vídeo. Use uma foto para baixar imagem ou um Reel/vídeo para extrair áudio.
            </p>
          ) : (
            <ul className="files">
              {videos.map((item, i) => (
                <li key={item.id}>
                  <span className="file-kind">MP4</span>
                  <span className="file-name" title={item.filename}>
                    Vídeo {i + 1}
                  </span>
                  <a className="btn btn-primary btn-sm" href={item.href} download={item.filename}>
                    Baixar
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {section === "image" && (
        <div className="ig-files">
          {images.length === 0 ? (
            <p className="ig-empty">
              Este link não tem imagem. Abra a aba de vídeo ou áudio para ver o que está disponível.
            </p>
          ) : (
            <ul className="files">
              {images.map((item, i) => (
                <li key={item.id}>
                  <span className="file-kind">{item.ext.toUpperCase()}</span>
                  <span className="file-name" title={item.filename}>
                    Foto {i + 1}
                  </span>
                  <a className="btn btn-primary btn-sm" href={item.href} download={item.filename}>
                    Baixar
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {section === "audio" && (
        <div className="ig-files">
          {videos.length === 0 ? (
            <p className="ig-empty">
              Não há vídeo neste link para extrair áudio. Cole um Reel ou vídeo do Instagram.
            </p>
          ) : (
            videos.map((item, i) => (
              <div className="ig-audio-block" key={item.id}>
                <div className="ig-audio-title">
                  Áudio do vídeo {i + 1} <span className="muted small">· MP3</span>
                </div>
                <div className="format-grid">
                  {qualities.map((o) => {
                    const key = `ig-${item.id}-${o.quality}`;
                    const busy = preparingKey === key;
                    const done = prepared[key];
                    return done ? (
                      <a
                        key={key}
                        className="format-btn format-btn--done"
                        href={done.href}
                        download={done.filename}
                      >
                        <span className="format-label">{o.label}</span>
                        <span className="format-action">Clique para baixar</span>
                      </a>
                    ) : (
                      <button
                        key={key}
                        type="button"
                        className="format-btn"
                        disabled={Boolean(preparingKey)}
                        onClick={() =>
                          onAudio(item.id, tokenFromHref(item.href), o.quality, audioTitle)
                        }
                      >
                        <span className="format-label">{o.label}</span>
                        <span className="format-action">{busy ? "Extraindo…" : "Baixar"}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {preparingKey && (
        <div className="panel panel-loading panel-inline" role="status">
          <span className="spinner" aria-hidden="true" />
          <span>Extraindo o áudio… isso pode levar alguns instantes.</span>
        </div>
      )}

      <p className="muted small">
        Os links de vídeo e imagem valem por 20 minutos. O MP3 é gerado no servidor; se expirar, faça a busca novamente.
      </p>
    </div>
  );
}

function ItemsPanel({ result }: { result: ItemsResult }) {
  const platformLabel =
    result.platform === "facebook" ? "Facebook" : "Instagram";
  return (
    <div className="panel result">
      <div className="result-label">{platformLabel} — resultado da pesquisa</div>

      <div className="result-card">
        <div className="result-media">
          {result.thumb ? (
            <img className="thumb" src={result.thumb} alt="Prévia" />
          ) : (
            <div className="thumb thumb-empty">Prévia</div>
          )}
          {result.items.length === 1 && (
            <a
              className="btn btn-primary result-dl-main"
              href={result.items[0].href}
              download={result.items[0].filename}
            >
              Baixar
            </a>
          )}
        </div>

        <div className="result-body">
          <div className="result-meta">
            {result.username && <span className="meta-user">@{result.username}</span>}
            {!result.username && result.author && <span className="meta-user">@{result.author}</span>}
            {result.takenAt ? <span className="muted">{timeAgo(result.takenAt)}</span> : null}
            {result.likeCount != null ? <span className="muted">{likesLabel(result.likeCount)}</span> : null}
          </div>

          {result.caption ? (
            <Caption text={result.caption} />
          ) : (
            <p className="muted small">Sem legenda disponível para esta publicação.</p>
          )}
        </div>
      </div>

      {result.items.length > 1 && (
        <div className="files-wrap">
          <div className="files-title">{result.items.length} arquivos</div>
          <ul className="files">
            {result.items.map((item, i) => (
              <li key={item.id}>
                <span className="file-kind">{item.ext.toUpperCase()}</span>
                <span className="file-name" title={item.filename}>
                  {item.kind === "image" ? `Foto ${i + 1}` : item.kind === "video" ? `Vídeo ${i + 1}` : item.filename}
                </span>
                <a className="btn btn-primary btn-sm" href={item.href} download={item.filename}>
                  Baixar
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="muted small">Os links valem por 20 minutos. Se expirar, basta gerar de novo.</p>
    </div>
  );
}

function OptionsPanel({
  result,
  preparingKey,
  prepared,
  onPrepare,
}: {
  result: MediaOptionsResult;
  preparingKey: string | null;
  prepared: Record<string, PrepareResult>;
  onPrepare: (type: "mp3" | "mp4", quality: string) => void;
}) {
  const mp3 = result.options.filter((o) => o.type === "mp3");
  const mp4 = result.options.filter((o) => o.type === "mp4");

  return (
    <div className="panel result">
      <div className="result-label">
        {result.platform === "youtube" ? "YouTube" : "Facebook"} — escolha o formato
      </div>

      <div className="result-card">
        <div className="result-media">
          {result.thumb ? (
            <img className="thumb" src={result.thumb} alt="Prévia" />
          ) : (
            <div className="thumb thumb-empty">Prévia</div>
          )}
        </div>

        <div className="result-body">
          <h2 className="media-title">{result.title}</h2>
          <div className="result-meta">
            {result.author && <span className="meta-user">{result.author}</span>}
            {result.duration ? <span className="muted">Duração: {durationLabel(result.duration)}</span> : null}
          </div>
          <p className="muted small">
            Selecione uma opção abaixo. O arquivo será preparado e o download começará automaticamente.
          </p>
        </div>
      </div>

      <div className="format-sections">
        <section className="format-section">
          <h3>Áudio (MP3)</h3>
          <div className="format-grid">
            {mp3.map((o) => {
              const key = `${o.type}-${o.quality}`;
              const busy = preparingKey === key;
              const done = prepared[key];
              return done ? (
                <a
                  key={key}
                  className="format-btn format-btn--done"
                  href={done.href}
                  download={done.filename}
                >
                  <span className="format-label">{o.label}</span>
                  <span className="format-action">Clique para baixar</span>
                </a>
              ) : (
                <button
                  key={key}
                  type="button"
                  className="format-btn"
                  disabled={Boolean(preparingKey)}
                  onClick={() => onPrepare("mp3", o.quality)}
                >
                  <span className="format-label">{o.label}</span>
                  <span className="format-action">{busy ? "Preparando…" : "Baixar"}</span>
                </button>
              );
            })}
          </div>
        </section>

        <section className="format-section">
          <h3>Vídeo (MP4)</h3>
          <div className="format-grid">
            {mp4.map((o) => {
              const key = `${o.type}-${o.quality}`;
              const busy = preparingKey === key;
              const done = prepared[key];
              return done ? (
                <a
                  key={key}
                  className="format-btn format-btn--done"
                  href={done.href}
                  download={done.filename}
                >
                  <span className="format-label">{o.label}</span>
                  <span className="format-action">Clique para baixar</span>
                </a>
              ) : (
                <button
                  key={key}
                  type="button"
                  className="format-btn"
                  disabled={Boolean(preparingKey)}
                  onClick={() => onPrepare("mp4", o.quality)}
                >
                  <span className="format-label">{o.label}</span>
                  <span className="format-action">{busy ? "Preparando…" : "Baixar"}</span>
                </button>
              );
            })}
          </div>
        </section>
      </div>

      {preparingKey && (
        <div className="panel panel-loading panel-inline" role="status">
          <span className="spinner" aria-hidden="true" />
          <span>Preparando o arquivo… isso pode levar alguns instantes.</span>
        </div>
      )}

      <p className="muted small">
        O link de download gerado vale por 20 minutos. A disponibilidade das qualidades depende do vídeo original.
      </p>
    </div>
  );
}

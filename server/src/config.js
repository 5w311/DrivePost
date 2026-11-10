import path from 'node:path';

const env = process.env;

// Picture heights the car can ask for.
export const QUALITIES = ['360', '480', '720', '1080'];

function int(name, fallback) {
  const n = parseInt(env[name], 10);
  return Number.isFinite(n) ? n : fallback;
}

function words(value) {
  return (value || '').split(/\s+/).filter(Boolean);
}

export const config = {
  port: int('PORT', 8080),
  dataDir: path.resolve(env.DATA_DIR || './data'),

  // Passcode the car (and anyone else) types once to sign in.
  passcode: env.DRIVE_PASSCODE || '',

  // Optional fixed token for the iPhone Shortcut. Generated and saved if unset.
  shareToken: env.SHARE_TOKEN || '',

  // Public base URL, e.g. https://drive.figari.dev. Used for QR codes and the
  // Shortcut instructions. Falls back to the request's host if unset.
  publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''),

  ytdlp: {
    bin: env.YTDLP_BIN || 'yt-dlp',
    // YouTube needs a JavaScript runtime. The Docker image ships Node, so
    // tell yt-dlp to use it. Set YTDLP_JS_RUNTIME= (empty) to leave it out.
    jsRuntime: env.YTDLP_JS_RUNTIME === undefined ? 'node' : env.YTDLP_JS_RUNTIME,
    extraArgs: words(env.YTDLP_ARGS),
    updateCmd: words(env.YTDLP_UPDATE_CMD),
  },

  // Where search suggestions come from (YouTube's own suggestion service).
  suggestUrl: env.SUGGEST_URL || 'https://suggestqueries.google.com/complete/search',

  ffmpegBin: env.FFMPEG_BIN || 'ffmpeg',
  maxStreams: int('MAX_STREAMS', 3),
  defaultQuality: QUALITIES.includes(env.DEFAULT_QUALITY) ? env.DEFAULT_QUALITY : '480',
};

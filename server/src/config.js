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

  // Where the car's Feedback button sends people: a "new issue" page that
  // takes ?title= and ?body=. Set FEEDBACK_URL= (empty) to hide the button, or
  // point it at your own fork.
  feedbackUrl: env.FEEDBACK_URL === undefined ? 'https://github.com/5w311/DrivePost/issues/new' : env.FEEDBACK_URL.trim(),

  // Where search suggestions come from (YouTube's own suggestion service).
  suggestUrl: env.SUGGEST_URL || 'https://suggestqueries.google.com/complete/search',

  // Where "videos like this one" come from: the same request youtube.com
  // makes to fill the list beside a video. No account, no key.
  relatedUrl: env.RELATED_URL || 'https://www.youtube.com/youtubei/v1/next?prettyPrint=false',

  // Which update is running: "3faa11d Title of the commit". Baked into the
  // image when it is built by the updater; empty otherwise.
  commit: (env.DRIVEPOST_COMMIT || '').trim().slice(0, 160),

  ffmpegBin: env.FFMPEG_BIN || 'ffmpeg',
  maxStreams: int('MAX_STREAMS', 3),
  defaultQuality: QUALITIES.includes(env.DEFAULT_QUALITY) ? env.DEFAULT_QUALITY : '480',
};

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

  // Videos from other sites than YouTube: a pasted or shared link to a post
  // on X, Reddit or Instagram, to a page with a video player on it, or
  // straight to a video file (see links.js).
  links: {
    // OTHER_SITES=off makes this a YouTube-only server again.
    on: !/^(off|0|no|false)$/i.test((env.OTHER_SITES || '').trim()),
    // Links into this server's own network (a NAS, a camera) are refused
    // unless OTHER_SITES_LOCAL=on.
    local: /^(on|1|yes|true)$/i.test((env.OTHER_SITES_LOCAL || '').trim()),
    // Extra yt-dlp arguments for other sites only, e.g. a cookies file for
    // the ones that only show videos to signed-in visitors.
    extraArgs: words(env.OTHER_SITES_ARGS),
  },

  // Pages: a link with no video to fetch is opened as a page in a browser of
  // the server's own (the browser container), and the car is shown that.
  pages: {
    // PAGES=off takes "Open as a page" away.
    on: !/^(off|0|no|false)$/i.test((env.PAGES || '').trim()),
    // The browser's program proves who it is with a key the two share. In
    // Docker, DrivePost writes it to a small volume both can see. BROWSER_KEY
    // sets it by hand (for running the two outside Docker).
    key: (env.BROWSER_KEY || '').trim(),
    keyFile: env.BROWSER_KEY_FILE || '/run/drivepost-browser/key',
    // The door the browser fetches everything through (guard.js). Not
    // published outside Docker.
    guardPort: Number(env.GUARD_PORT) || 8081,
    // A page nobody is watching or steering is closed after this long.
    idleMs: (Number(env.PAGE_IDLE_SECONDS) || 5 * 60) * 1000,
    // Where the page's picture is kept while it plays (a few megabytes,
    // rewritten every second). Memory by default; PAGES_DIR= names a folder.
    dir: (env.PAGES_DIR || env.SCREEN_DIR || '').trim(),
  },

  ffmpegBin: env.FFMPEG_BIN || 'ffmpeg',
  ffprobeBin: env.FFPROBE_BIN || 'ffprobe',
  maxStreams: int('MAX_STREAMS', 3),
  defaultQuality: QUALITIES.includes(env.DEFAULT_QUALITY) ? env.DEFAULT_QUALITY : '480',
};

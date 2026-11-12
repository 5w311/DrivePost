/*
 * Can the server play this link to another site, right now?
 *
 *   docker compose exec -T drivepost node src/check-link.js "https://x.com/..." [quality] [--details]
 *
 * The same check as check-youtube.js, under the name people look for. Prints
 * no links, so the output is safe to share.
 */
import './check-youtube.js';

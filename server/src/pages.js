// Pages are stamped with the version they were built from, and ask for their
// scripts and styles by that version. A browser that brings a page back from
// its own saved copy (as car browsers do when reopened) then has a page that
// knows it is old, and reloads itself once it hears the server's version.
export function stampPage(html, version) {
  return html
    .replace(/<html\b/, `<html data-version="${version}"`)
    .replace(/((?:src|href)="\/static\/[^"?]+\.(?:js|css))"/g, `$1?v=${version}"`);
}

// The link behind the car's Feedback QR code: a new GitHub issue with the
// car's technical details already filled in, ready for someone to describe
// what happened. The details are kept short and plain so the QR code stays
// easy to scan from a car screen. Issues are public, so nothing personal
// goes in: no video, no server address.
export function feedbackLink(base, details, version) {
  const lines = String(details || '')
    .replace(/[^\x20-\x7E\n]/g, '')
    .split('\n')
    .map((l) => l.trim().slice(0, 140))
    .filter(Boolean)
    .slice(0, 12);
  lines.push(`Build: ${version}`);
  const body = `**What happened?**\n\n\n\n---\nDetails from the car, added automatically:\n\n${lines.map((l) => `- ${l}`).join('\n')}\n`;
  // Encoded as lightly as a web address allows: every character saved makes
  // the QR code coarser and easier to scan.
  const light = (text) =>
    encodeURIComponent(text).replace(/%20/g, '+').replace(/%3A/g, ':').replace(/%2C/g, ',').replace(/%2F/g, '/');
  return `${base}${base.includes('?') ? '&' : '?'}title=${light('Feedback: ')}&body=${light(body)}`;
}
